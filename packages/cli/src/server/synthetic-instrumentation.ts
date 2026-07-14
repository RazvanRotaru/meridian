/** TypeScript before-transformer that wraps supported callable bodies without editing source. */

import { relative } from "node:path";
import { ts } from "ts-morph";
import type { CallableCandidate } from "./synthetic-reachability";
import { candidateKey, normalizeRelative } from "./synthetic-reachability";

const PROBE_GLOBAL = "__MERIDIAN_SYNTHETIC_PROBE__";

export function instrumentationTransformer(
  sourceRoot: string,
  candidates: ReadonlyMap<string, CallableCandidate[]>,
  instrumented: Set<string>,
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const visitor: ts.Visitor = (node) => {
      const identity = callableIdentity(node, sourceRoot);
      const matches = identity === null
        ? undefined
        : candidates.get(candidateKey(identity.file, identity.line, identity.name));
      // A plausible join is not evidence. Same-file/line/name ambiguity stays unsupported until
      // the manifest/artifact carries a stronger source coordinate.
      const candidate = matches?.length === 1 ? matches[0]! : null;
      if (candidate !== null && isCallableSyntax(node) && hasSupportedBody(node)) {
        const visitedBody = visitInstrumentedBody(node.body, visitor, context, sourceRoot);
        instrumented.add(candidate.id);
        return updateCallable(node, wrappedBody(node, visitedBody, candidate.id));
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return (sourceFile) => ts.visitNode(sourceFile, visitor) as ts.SourceFile;
  };
}

/** Instrument control syntax only while it belongs to a callable that receives its own span.
 * Nested functions return to the outer callable visitor: a separately matched callable owns its
 * events, while an unmatched callback is deliberately left alone rather than being misattributed
 * to the surrounding span. */
function visitInstrumentedBody(
  body: ts.ConciseBody,
  callableVisitor: ts.Visitor,
  context: ts.TransformationContext,
  sourceRoot: string,
): ts.ConciseBody {
  const controlVisitor: ts.Visitor = (node) => {
    if (isCallableSyntax(node)) {
      return ts.visitNode(node, callableVisitor);
    }
    if (ts.isIfStatement(node)) {
      const condition = ts.visitNode(node.expression, controlVisitor) as ts.Expression;
      const thenStatement = ts.visitNode(node.thenStatement, controlVisitor) as ts.Statement;
      const elseStatement = node.elseStatement === undefined
        ? undefined
        : ts.visitNode(node.elseStatement, controlVisitor) as ts.Statement;
      return ts.factory.updateIfStatement(
        node,
        observedBranch(condition, node, node.expression, "if", sourceRoot),
        thenStatement,
        elseStatement,
      );
    }
    if (ts.isConditionalExpression(node)) {
      const condition = ts.visitNode(node.condition, controlVisitor) as ts.Expression;
      const whenTrue = ts.visitNode(node.whenTrue, controlVisitor) as ts.Expression;
      const whenFalse = ts.visitNode(node.whenFalse, controlVisitor) as ts.Expression;
      return ts.factory.updateConditionalExpression(
        node,
        observedBranch(condition, node, node.condition, "conditional", sourceRoot),
        node.questionToken,
        whenTrue,
        node.colonToken,
        whenFalse,
      );
    }
    if (ts.isCatchClause(node)) {
      return guardedCatchClause(node, controlVisitor, context);
    }
    if (ts.isCallExpression(node) && isTraceableCall(node)) {
      const call = ts.visitEachChild(node, controlVisitor, context) as ts.CallExpression;
      const site = observationSite(node, "call", sourceRoot);
      const thunk = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        call,
      );
      return probeCall("call", [
        ts.factory.createStringLiteral(`${site.file}:${site.line}:${site.col}`),
        thunk,
      ]);
    }
    if (ts.isForOfStatement(node)) {
      const initializer = ts.visitNode(node.initializer, controlVisitor) as ts.ForInitializer;
      const expression = ts.visitNode(node.expression, controlVisitor) as ts.Expression;
      const statement = ts.visitNode(node.statement, controlVisitor) as ts.Statement;
      return ts.factory.updateForOfStatement(
        node,
        node.awaitModifier,
        initializer,
        expression,
        observedLoopBody(statement, node, `for … of ${sourceText(node.expression)}`, "for-of", sourceRoot),
      );
    }
    if (ts.isForInStatement(node)) {
      const initializer = ts.visitNode(node.initializer, controlVisitor) as ts.ForInitializer;
      const expression = ts.visitNode(node.expression, controlVisitor) as ts.Expression;
      const statement = ts.visitNode(node.statement, controlVisitor) as ts.Statement;
      return ts.factory.updateForInStatement(
        node,
        initializer,
        expression,
        observedLoopBody(statement, node, `for … in ${sourceText(node.expression)}`, "for-in", sourceRoot),
      );
    }
    if (ts.isForStatement(node)) {
      const initializer = node.initializer === undefined
        ? undefined
        : ts.visitNode(node.initializer, controlVisitor) as ts.ForInitializer;
      const condition = node.condition === undefined
        ? undefined
        : ts.visitNode(node.condition, controlVisitor) as ts.Expression;
      const incrementor = node.incrementor === undefined
        ? undefined
        : ts.visitNode(node.incrementor, controlVisitor) as ts.Expression;
      const statement = ts.visitNode(node.statement, controlVisitor) as ts.Statement;
      return ts.factory.updateForStatement(
        node,
        initializer,
        condition,
        incrementor,
        observedLoopBody(
          statement,
          node,
          `for (${node.condition === undefined ? "ever" : sourceText(node.condition)})`,
          "for",
          sourceRoot,
        ),
      );
    }
    if (ts.isWhileStatement(node)) {
      const expression = ts.visitNode(node.expression, controlVisitor) as ts.Expression;
      const statement = ts.visitNode(node.statement, controlVisitor) as ts.Statement;
      return ts.factory.updateWhileStatement(
        node,
        expression,
        observedLoopBody(statement, node, `while (${sourceText(node.expression)})`, "while", sourceRoot),
      );
    }
    if (ts.isDoStatement(node)) {
      const statement = ts.visitNode(node.statement, controlVisitor) as ts.Statement;
      const expression = ts.visitNode(node.expression, controlVisitor) as ts.Expression;
      return ts.factory.updateDoStatement(
        node,
        observedLoopBody(statement, node, `do … while (${sourceText(node.expression)})`, "do", sourceRoot),
        expression,
      );
    }
    return ts.visitEachChild(node, controlVisitor, context);
  };
  return ts.visitNode(body, controlVisitor) as ts.ConciseBody;
}

function isTraceableCall(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return false;
  }
  return !(ts.isIdentifier(node.expression) && node.expression.text === "eval");
}

function observedBranch(
  expression: ts.Expression,
  sourceNode: ts.Node,
  sourceExpression: ts.Expression,
  kind: string,
  sourceRoot: string,
): ts.Expression {
  // Static Logic anchors a branch at the complete `if`/conditional syntax, not at the first token
  // of its condition. Keep source coordinates identical so request traversal can join exactly.
  const site = observationSite(sourceNode, kind, sourceRoot);
  return probeCall("branch", [
    ts.factory.createStringLiteral(site.id),
    ts.factory.createStringLiteral(sourceText(sourceExpression)),
    sourceLiteral(site),
    expression,
  ]);
}

function observedLoopBody(
  statement: ts.Statement,
  sourceNode: ts.Node,
  label: string,
  kind: string,
  sourceRoot: string,
): ts.Block {
  const site = observationSite(sourceNode, kind, sourceRoot);
  const observation = ts.factory.createExpressionStatement(probeCall("loop", [
    ts.factory.createStringLiteral(site.id),
    ts.factory.createStringLiteral(label.slice(0, 4_096)),
    sourceLiteral(site),
  ]));
  return ts.isBlock(statement)
    ? ts.factory.updateBlock(statement, [observation, ...statement.statements])
    : ts.factory.createBlock([observation, statement], true);
}

interface ObservationSite {
  id: string;
  file: string;
  line: number;
  col: number;
}

function observationSite(node: ts.Node, kind: string, sourceRoot: string): ObservationSite {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const relativeFile = normalizeRelative(relative(sourceRoot, sourceFile.fileName));
  return {
    id: `synthetic:${position.line + 1}:${position.character}:${kind}`,
    // Trace source paths are bounded. Preserve the basename used by the renderer's source join if
    // an unusually deep local checkout exceeds the contract rather than invalidating the run.
    file: relativeFile.slice(-2_048),
    line: position.line + 1,
    col: position.character,
  };
}

function sourceLiteral(site: ObservationSite): ts.ObjectLiteralExpression {
  return ts.factory.createObjectLiteralExpression([
    ts.factory.createPropertyAssignment("file", ts.factory.createStringLiteral(site.file)),
    ts.factory.createPropertyAssignment("line", ts.factory.createNumericLiteral(site.line)),
    ts.factory.createPropertyAssignment("col", ts.factory.createNumericLiteral(site.col)),
  ], false);
}

function sourceText(node: ts.Node): string {
  return node.getText(node.getSourceFile()).slice(0, 4_096);
}

function probeCall(method: string, args: ts.Expression[]): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(probeExpression(), method),
    undefined,
    args,
  );
}

function probeExpression(): ts.ElementAccessExpression {
  return ts.factory.createElementAccessExpression(
    ts.factory.createIdentifier("globalThis"),
    ts.factory.createStringLiteral(PROBE_GLOBAL),
  );
}

/** A watcher stop is a runner control signal, not an application exception. Ensure ordinary
 * reachable catch blocks cannot turn it into a handled business branch. `finally` still runs by
 * normal JavaScript semantics. */
function guardedCatchClause(
  node: ts.CatchClause,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.CatchClause {
  const visitedBlock = ts.visitEachChild(node.block, visitor, context) as ts.Block;
  let declaration = node.variableDeclaration;
  let caught: ts.Identifier;
  const prefix: ts.Statement[] = [];
  if (declaration === undefined) {
    caught = ts.factory.createUniqueName("__meridianCaught");
    declaration = ts.factory.createVariableDeclaration(caught);
  } else if (ts.isIdentifier(declaration.name)) {
    caught = declaration.name;
  } else {
    caught = ts.factory.createUniqueName("__meridianCaught");
    const original = declaration;
    declaration = ts.factory.createVariableDeclaration(caught);
    prefix.push(ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList([
        ts.factory.createVariableDeclaration(original.name, undefined, undefined, caught),
      ], ts.NodeFlags.Const),
    ));
  }
  const guard = ts.factory.createExpressionStatement(ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(probeExpression(), "rethrowIfControl"),
    undefined,
    [caught],
  ));
  return ts.factory.updateCatchClause(
    node,
    declaration,
    ts.factory.updateBlock(visitedBlock, [guard, ...prefix, ...visitedBlock.statements]),
  );
}

interface CallableIdentity {
  file: string;
  line: number;
  name: string;
}

function callableIdentity(node: ts.Node, sourceRoot: string): CallableIdentity | null {
  if (!isCallableSyntax(node)) return null;
  const anchor = callableAnchor(node);
  if (anchor === null) return null;
  const name = callableName(node, anchor);
  if (name === null) return null;
  const sourceFile = node.getSourceFile();
  const file = normalizeRelative(relative(sourceRoot, sourceFile.fileName));
  if (file.startsWith("../") || file === "..") return null;
  return {
    file,
    line: sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile)).line + 1,
    name,
  };
}

function isCallableSyntax(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function hasSupportedBody(
  node: ts.FunctionLikeDeclaration,
): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return node.body !== undefined
    && !ts.isConstructorDeclaration(node)
    && !("asteriskToken" in node && node.asteriskToken !== undefined);
}

function callableAnchor(node: ts.FunctionLikeDeclaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
  ) return node;

  let expression: ts.Expression = node;
  while (
    ts.isCallExpression(expression.parent)
    && expression.parent.arguments[0] === expression
    && isComponentWrapper(expression.parent.expression)
  ) expression = expression.parent;
  const parent = expression.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) return parent;
  if (ts.isPropertyDeclaration(parent) && parent.initializer === expression) return parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === expression) return parent;
  if (ts.isExportAssignment(parent) && parent.expression === expression && !parent.isExportEquals) return parent;
  return null;
}

function isComponentWrapper(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "memo" || expression.text === "forwardRef";
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "React"
    && (expression.name.text === "memo" || expression.name.text === "forwardRef");
}

function callableName(node: ts.FunctionLikeDeclaration, anchor: ts.Node): string | null {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return propertyName(node.name);
  }
  if (ts.isVariableDeclaration(anchor) || ts.isPropertyDeclaration(anchor) || ts.isPropertyAssignment(anchor)) {
    return propertyName(anchor.name);
  }
  return ts.isExportAssignment(anchor) ? "default" : null;
}

function propertyName(name: ts.BindingName | ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : null;
}

function wrappedBody(
  node: ts.FunctionLikeDeclaration & { body: ts.ConciseBody },
  originalBody: ts.ConciseBody,
  nodeId: string,
): ts.Block {
  const asyncModifier = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ? [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)]
    : undefined;
  const thunk = ts.factory.createArrowFunction(
    asyncModifier,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    originalBody,
  );
  const call = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(probeExpression(), "run"),
    undefined,
    [
      ts.factory.createStringLiteral(nodeId),
      inputExpression(node.parameters),
      inputRebinder(node.parameters),
      thunk,
    ],
  );
  return ts.factory.createBlock([ts.factory.createReturnStatement(call)], true);
}

/** Only simple identifier bindings have a lossless round trip through the current boundary input
 * shape. Destructuring is explicitly unsupported so an override can never appear to apply while
 * the live parameters remain unchanged. */
function inputRebinder(parameters: readonly ts.ParameterDeclaration[]): ts.Expression {
  const runtimeParameters = parameters.filter((parameter) => !isThisParameter(parameter));
  if (!runtimeParameters.every((parameter) => ts.isIdentifier(parameter.name))) {
    return ts.factory.createNull();
  }
  const effective = ts.factory.createUniqueName("__meridianInput");
  return ts.factory.createArrowFunction(
    undefined,
    undefined,
    [ts.factory.createParameterDeclaration(undefined, undefined, effective)],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock(runtimeParameters.map((parameter) => {
      const name = (parameter.name as ts.Identifier).text;
      return ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(
        ts.factory.createIdentifier(name),
        ts.factory.createToken(ts.SyntaxKind.EqualsToken),
        ts.factory.createElementAccessExpression(effective, ts.factory.createStringLiteral(name)),
      ));
    }), true),
  );
}

function inputExpression(parameters: readonly ts.ParameterDeclaration[]): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];
  parameters.forEach((parameter, index) => {
    if (isThisParameter(parameter)) return;
    if (ts.isIdentifier(parameter.name)) {
      properties.push(ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral(parameter.name.text),
        ts.factory.createIdentifier(parameter.name.text),
      ));
      return;
    }
    properties.push(ts.factory.createPropertyAssignment(
      ts.factory.createStringLiteral(`arg${index}`),
      ts.factory.createObjectLiteralExpression(
        bindingIdentifiers(parameter.name).map((name) => ts.factory.createShorthandPropertyAssignment(name)),
        false,
      ),
    ));
  });
  return ts.factory.createObjectLiteralExpression(properties, false);
}

function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

function bindingIdentifiers(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function updateCallable(node: ts.FunctionLikeDeclaration & { body: ts.ConciseBody }, body: ts.Block): ts.Node {
  if (ts.isFunctionDeclaration(node)) return ts.factory.updateFunctionDeclaration(
    node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body,
  );
  if (ts.isFunctionExpression(node)) return ts.factory.updateFunctionExpression(
    node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body,
  );
  if (ts.isArrowFunction(node)) return ts.factory.updateArrowFunction(
    node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, body,
  );
  if (ts.isMethodDeclaration(node)) return ts.factory.updateMethodDeclaration(
    node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, body,
  );
  if (ts.isGetAccessorDeclaration(node)) return ts.factory.updateGetAccessorDeclaration(
    node, node.modifiers, node.name, node.parameters, node.type, body,
  );
  if (ts.isSetAccessorDeclaration(node)) return ts.factory.updateSetAccessorDeclaration(
    node, node.modifiers, node.name, node.parameters, body,
  );
  return node;
}

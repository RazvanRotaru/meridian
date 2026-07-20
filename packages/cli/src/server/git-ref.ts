/**
 * Git's `check-ref-format --branch` rules, plus an explicit leading-dash guard because the branch is
 * passed after `git clone --branch`. The process runner is argv-only, so valid characters such as
 * `+`, `@`, `$`, and Unicode are safe and should not disappear from the branch picker.
 */

const FORBIDDEN_REF_CHARACTER = /[\x00-\x20\x7f~^:?*\[\\]/u;

export function isAllowedCloneRef(value: string): boolean {
  if (
    value.length === 0
    || value.startsWith("-")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value === "HEAD"
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || FORBIDDEN_REF_CHARACTER.test(value)
  ) {
    return false;
  }
  return value.split("/").every((component) => (
    component.length > 0
    && !component.startsWith(".")
    && !component.endsWith(".lock")
  ));
}

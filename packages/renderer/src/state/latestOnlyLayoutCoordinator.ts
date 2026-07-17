import {
  LatestOnlyAsyncRunner,
  type LatestOnlyAsyncOutcome,
} from "./latestOnlyAsyncRunner";

export type LayoutWorkOwner = "module" | "logic" | "minimal" | "flow-pane";
export type LayoutWork = (signal: AbortSignal) => Promise<void>;

interface OwnedLayoutWork {
  owner: LayoutWorkOwner;
  execute: LayoutWork;
}

/**
 * One global structural lane prevents Map, Logic, and Extract navigation from retaining independent
 * stale projections. The flow pane has a separate lane because it is the only layout surface which
 * can be visibly mounted beside a structural lens.
 */
export class LatestOnlyLayoutCoordinator {
  private readonly structural = new LatestOnlyAsyncRunner<OwnedLayoutWork>(executeOwnedWork);
  private readonly flowPane = new LatestOnlyAsyncRunner<OwnedLayoutWork>(executeOwnedWork);

  run(owner: LayoutWorkOwner, execute: LayoutWork): Promise<LatestOnlyAsyncOutcome> {
    const work = { owner, execute };
    return owner === "flow-pane"
      ? this.flowPane.run(work)
      : this.structural.run(work);
  }

  cancel(owner: LayoutWorkOwner): void {
    this.runnerFor(owner).cancelWhere((work) => work.owner === owner);
  }

  /** A projection install may be shared by explicitly registered layout owners. Every other active
   * or queued layout belongs to the outgoing artifact and must be cooperatively cancelled. */
  cancelAllExcept(retainedOwners: ReadonlySet<LayoutWorkOwner>): void {
    this.structural.cancelWhere((work) => !retainedOwners.has(work.owner));
    this.flowPane.cancelWhere((work) => !retainedOwners.has(work.owner));
  }

  dispose(): void {
    this.structural.dispose();
    this.flowPane.dispose();
  }

  private runnerFor(owner: LayoutWorkOwner): LatestOnlyAsyncRunner<OwnedLayoutWork> {
    return owner === "flow-pane" ? this.flowPane : this.structural;
  }
}

function executeOwnedWork(work: OwnedLayoutWork, signal: AbortSignal): Promise<void> {
  return work.execute(signal);
}

/**
 * Compatibility export for the persisted `timeline` preference key.
 *
 * The old pseudo-time projection has become a participant sequence diagram, but keeping this
 * module and component name avoids migrating stored review preferences or callers.
 */
export {
  SequenceTimelineView as TimelineView,
  type SequenceTimelineViewProps as TimelineViewProps,
} from "./SequenceTimelineView";

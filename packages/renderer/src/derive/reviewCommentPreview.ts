export interface ReviewCommentNodePreview {
  key: string;
  kind: "draft" | "existing";
  body: string;
  author: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  lineStale: boolean;
  url: string | null;
}

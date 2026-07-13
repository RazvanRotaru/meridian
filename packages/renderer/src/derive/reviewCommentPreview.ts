export interface ReviewCommentNodePreview {
  key: string;
  kind: "draft" | "existing";
  body: string;
  author: string;
  line: number | null;
  lineStale: boolean;
  url: string | null;
}

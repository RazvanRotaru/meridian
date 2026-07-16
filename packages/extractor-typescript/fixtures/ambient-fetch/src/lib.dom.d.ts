// A project-local ambient must not gain platform provenance merely by copying a standard-lib name.
interface Response {
  readonly ok: boolean;
}

declare function fetch(path: string): Promise<Response>;

interface PromiseConstructorLike<T> {
  (value: T): void;
}

declare class Promise<T> {
  constructor(executor: (resolve: PromiseConstructorLike<T>) => void);
}

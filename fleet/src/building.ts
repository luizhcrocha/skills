/** A record built field by field before it is handed on: `T` with its fields writable. */
export type Building<T> = { -readonly [K in keyof T]: T[K] };

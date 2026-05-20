export type WithoutUndefinedValues<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends Record<string, unknown>>(value: T): WithoutUndefinedValues<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as WithoutUndefinedValues<T>;
}

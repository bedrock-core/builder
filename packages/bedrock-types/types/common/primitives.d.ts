export type Vector2 = [number, number];
export type Vector3 = [number, number, number];
export type MolangExpression = string | number;
export type MolangVector2 = [MolangExpression, MolangExpression];
export type MolangVector3 = [MolangExpression, MolangExpression, MolangExpression];
export type ConditionalReference = string | Record<string, MolangExpression>;
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ArrayLengths<Limit extends number, Values extends number[] = []>
  = number extends Limit ? number : Values['length'] extends Limit ? Values[number] : ArrayLengths<Limit, [...Values, Values['length']]>;

/** An array whose length stays within the inclusive bounds. */
export type BoundedArray<T, Minimum extends number, Maximum extends number>
  = T[] & { length: Exclude<ArrayLengths<Maximum>, ArrayLengths<Minimum>> | Maximum };

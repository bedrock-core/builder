import type { FilterValues } from './filter-values';

/** A native test and the comparison value accepted by that test. */
export type FilterTest = {
  [Name in keyof FilterValues]: {
    test: Name;
    domain?: string;
    operator?: string;
    subject?: string;
    value?: FilterValues[Name];
  };
}[keyof FilterValues];

/** A single test, a list of tests, or recursively grouped tests. */
export type FilterGroup = FilterTest | FilterGroup[] | {
  all_of?: FilterGroup;
  any_of?: FilterGroup;
  none_of?: FilterGroup;
  all?: FilterGroup;
  any?: FilterGroup;
  AND?: FilterGroup;
  OR?: FilterGroup;
  NOT?: FilterGroup;
};

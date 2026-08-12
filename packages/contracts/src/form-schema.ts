/**
 * The application form is lender-defined DATA, not markup.
 *
 * A `form_schemas` row holds steps, fields and rules; Angular renders them at
 * runtime and derives its validators from them. The same schema validates
 * server-side at the `draft → submitted` boundary, so client and server
 * validation cannot drift.
 *
 * Adding a field is a data change, not a code change.
 */

import type { EligibilityRule } from './eligibility.js';

export const FIELD_TYPES = ['text', 'number', 'select', 'textarea'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FormField {
  key: string;
  type: FieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  /** Render as currency and store as integer cents. */
  money?: boolean;
}

export interface FormStep {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormSchema {
  id: string;
  name: string;
  version: number;
  steps: FormStep[];
  rules: EligibilityRule[];
}

export function allFields(schema: Pick<FormSchema, 'steps'>): FormField[] {
  return schema.steps.flatMap((step) => step.fields);
}

export function requiredFieldKeys(schema: Pick<FormSchema, 'steps'>): string[] {
  return allFields(schema)
    .filter((field) => field.required === true)
    .map((field) => field.key);
}

export function findField(
  schema: Pick<FormSchema, 'steps'>,
  key: string,
): FormField | undefined {
  return allFields(schema).find((field) => field.key === key);
}

export interface FieldError {
  key: string;
  message: string;
}

/**
 * Validate a payload against the schema. Used by the Angular form for per-field
 * messages and by the API at submit time — one definition, two consumers.
 *
 * `partial` skips required checks, which is what autosave on a half-filled draft
 * needs; the submit boundary calls it with `partial: false`.
 */
export function validatePayload(
  schema: Pick<FormSchema, 'steps'>,
  payload: Record<string, unknown>,
  options: { partial?: boolean } = {},
): FieldError[] {
  const partial = options.partial === true;
  const errors: FieldError[] = [];

  for (const field of allFields(schema)) {
    const value = payload[field.key];
    const empty = value === undefined || value === null || value === '';

    if (empty) {
      if (!partial && field.required === true) {
        errors.push({ key: field.key, message: `${field.label} is required.` });
      }
      continue;
    }

    if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push({ key: field.key, message: `${field.label} must be a number.` });
        continue;
      }
      if (field.min !== undefined && n < field.min) {
        errors.push({ key: field.key, message: `${field.label} must be at least ${field.min}.` });
      }
      if (field.max !== undefined && n > field.max) {
        errors.push({ key: field.key, message: `${field.label} must be at most ${field.max}.` });
      }
      continue;
    }

    if (field.type === 'select') {
      if (field.options && !field.options.includes(String(value))) {
        errors.push({ key: field.key, message: `${field.label} is not a valid choice.` });
      }
      continue;
    }

    // text / textarea
    const text = String(value);
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      errors.push({
        key: field.key,
        message: `${field.label} must be ${field.maxLength} characters or fewer.`,
      });
    }
  }

  return errors;
}

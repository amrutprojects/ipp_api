import { FIELDS } from '../db/seeds/data';
import { FIELD_KIND, FIELD_TYPES, type FieldType } from './constants';

/*
 * The program's own fields. Like an own field, each can be renamed, moved, switched off, made optional and given checks. What
 * is special about them is what their answers are used for, which decides the types they can have.
 */
interface TypedField {
  key: string;
  type: FieldType;
  isCustom: boolean;
}

/* The type each one comes with. */
const COMES_AS: Record<string, FieldType> = Object.fromEntries([...FIELDS[1], ...FIELDS[2]].map((f) => [f.key, f.type]));

/*
 * The account has the same name, mobile number and e-mail, the Aadhaar number is stored apart (encrypted), and the disability
 * details are asked after a Yes: their type stays.
 */
const ONE_TYPE: readonly string[] = ['first_name', 'last_name', 'email', 'mobile_number', 'aadhaar_number', 'disability_status'];
/* One choice of a list of the Masters (or of the districts or centers), as a dropdown or as radio buttons. */
const ofList = (key: string) => key in FIELD_KIND || key === 'district_id' || key === 'centre_id';
const LIST_TYPES: readonly FieldType[] = ['DROPDOWN', 'RADIO'];

/* The types a field can be given. */
export function typesOf(f: TypedField): readonly FieldType[] {
  if (f.isCustom) return FIELD_TYPES;
  if (ONE_TYPE.includes(f.key)) return [COMES_AS[f.key]!];
  return ofList(f.key) ? LIST_TYPES : FIELD_TYPES;
}

/*
 * Whether a field's answers are checked and shown by its type alone, with choices of its own: an own field, and one of the
 * program's that was given another type than it comes with (its own format, rules.ts, no longer applies).
 */
export const byType = (f: TypedField): boolean => f.isCustom || (!ofList(f.key) && f.type !== COMES_AS[f.key]);

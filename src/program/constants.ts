/* What the 3 Month Internship Placement Program is made of: names, kinds of masters, steps and approval stages. */
export const PROGRAM_TITLE = '3 Month Internship Placement Program';
export const ORGANISATION = 'Sumago Infotech Pvt. Ltd.';

/* ---------------------------------------------------------------------------------------------------------- dropdowns */

/* A "linked" kind's value in a form is the choice's id; any other kind's is its code. */
export const LINKED_KINDS = ['CASTE', 'EDUCATION', 'REGION'] as const;
export const PROGRAM_KINDS = [
  ...LINKED_KINDS,
  'RELIGION',
  'GENDER',
  'MARITAL_STATUS',
  'EDUCATIONAL_STATUS',
  'GRADING_TYPE',
  'CGPA_SCALE',
  'QUALIFICATION_CLASS',
  'TECHNOLOGY',
] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];
export const isLinkedKind = (kind: string) => (LINKED_KINDS as readonly string[]).includes(kind);
export const isProgramKind = (kind: string): kind is ProgramKind => (PROGRAM_KINDS as readonly string[]).includes(kind);
/* Their choices are renamed or switched on and off, never added or deleted: the score is checked by these codes. */
export const FIXED_KINDS: readonly string[] = ['GRADING_TYPE'];
/* Castes and religions are shown by their Marathi name; everything else by the English one. */
export const MARATHI_KINDS: readonly string[] = ['CASTE', 'RELIGION'];

/* The form fields whose choices are a kind (District and Center Name have lists of their own, Disability is Yes / No). */
export const FIELD_KIND: Record<string, ProgramKind> = {
  caste_id: 'CASTE',
  education_id: 'EDUCATION',
  region_id: 'REGION',
  religion: 'RELIGION',
  gender: 'GENDER',
  marital_status: 'MARITAL_STATUS',
  educational_status: 'EDUCATIONAL_STATUS',
  grading_type: 'GRADING_TYPE',
  cgpa_scale: 'CGPA_SCALE',
  qualification_class: 'QUALIFICATION_CLASS',
  technology: 'TECHNOLOGY',
};
export const YES_NO = ['Yes', 'No'] as const;

/* Longest names and orders of every master. */
export const NAME_MAX = 150;
export const ORDER_MAX = 9999;

/* ---------------------------------------------------------------------------------------------------------------- form */

export const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'MOBILE',
  'URL',
  'NUMBER',
  'DATE',
  'TIME',
  'MONTH',
  'YEAR',
  'DROPDOWN',
  'RADIO',
  'CHECKBOXES',
  'YES_NO',
  'CONSENT',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const DOCUMENT_KINDS = ['DOCUMENT', 'VIDEO'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/* An own field's key is x_<slug>; its choices are the kind FIELD:x_<slug>. */
export const CUSTOM_KEY_PREFIX = 'x_';
export const CUSTOM_SLUG_MAX = 40;
export const fieldOptionKind = (key: string) => `FIELD:${key}`;
/* The longest value of any field, and the most values of one save. */
export const FORM_VALUE_MAX = 2000;
export const FORM_VALUES_MAX = 200;

export type Form = Record<string, string>;
export type Step = 1 | 2;

/* -------------------------------------------------------------------------------------------------- how far a student got */

export const STAGES = {
  OTP_PENDING: 'Account created – OTP not verified',
  VERIFIED: 'OTP verified – form not started',
  BASIC_DONE: 'Step 1 filled (Basic Details)',
  MAIN_DONE: 'Step 2 filled (Main Form)',
  SUBMITTED: 'Form submitted',
} as const;
export type Stage = keyof typeof STAGES;

export const FOLLOW_UP_STATUS = {
  PENDING: 'Pending follow-up',
  CALLED: 'Follow-up call',
  SECOND_CALL: 'Second follow-up',
  FORM_FILLED: 'Form filled',
} as const;
export type FollowUpStatus = keyof typeof FOLLOW_UP_STATUS;

/* -------------------------------------------------------------------------------------------------------------- approval */

/*
 * A submitted form: the Auditor verifies each document and approves it (BATCH: waiting for a batch), then puts it into a
 * batch, which sends it on to the Divisional Officer → COEP → Head Office (unless optional) → Admin → APPROVED. A rejected
 * student goes back one stage, in the same batch; from the Divisional Officer, back to the Auditor (no stage), whose new
 * approval sends it straight to the Divisional Officer. The officers' part is not in this portal yet; its stages are stored
 * from the start.
 */
export const OFFICER_STAGES = ['DIVISION', 'COEP', 'HEAD_OFFICE', 'ADMIN', 'APPROVED'] as const;
export const APPROVAL_STAGES = ['BATCH', ...OFFICER_STAGES] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];
/* Where an approval event starts or ends: AUDITOR = with the Auditor (no stage). */
export type StagePoint = 'AUDITOR' | ApprovalStage;
export const STAGE_NAME: Record<StagePoint, string> = {
  AUDITOR: 'Auditor',
  BATCH: 'Batch',
  DIVISION: 'Divisional Officer',
  COEP: 'COEP',
  HEAD_OFFICE: 'Head Office',
  ADMIN: 'Admin',
  APPROVED: 'Final approval',
};
export const STAGE_STATUS: Record<ApprovalStage, string> = {
  BATCH: 'Approved: waiting for a batch',
  DIVISION: 'With Divisional Officer',
  COEP: 'With COEP',
  HEAD_OFFICE: 'With Head Office',
  ADMIN: 'With Admin (final approval)',
  APPROVED: 'Final approved',
};
/* The "approval" filter: AWAITING = submitted, with the Auditor (RETURNED = of those, sent back); or a stage. */
export const APPROVAL_FILTERS = ['AWAITING', 'RETURNED', ...APPROVAL_STAGES] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];
/* The "Stage of application" filter: how far the form got, then whom it is with. */
export const APPLICATION_STAGES = {
  OTP_PENDING: 'OTP pending',
  VERIFIED: 'Account verified',
  BASIC_DONE: 'Step 1 filled',
  MAIN_DONE: 'Step 2 filled',
  AUDITOR: 'Submitted: with the Auditor',
  RETURNED: 'Sent back to the Auditor',
  ...STAGE_STATUS,
} as const;
export type ApplicationStage = keyof typeof APPLICATION_STAGES;

/* --------------------------------------------------------------------------------------------------------------- batches */

export const BATCH_SIZE = { MIN: 1, MAX: 100, DEFAULT: 30 } as const;
export const BATCH_NAME_MAX = 120;
export const DELIVERY_MODES = ['OFFLINE', 'ONLINE', 'BLENDED'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

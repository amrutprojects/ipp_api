-- Every student's documents are kept in one folder of their own, named after them: "Asha Patil 9876501234" (first name, last
-- name, mobile number), under candidates/. The name is chosen when the first document is stored and follows a correction of the
-- name or the mobile number. Two students of the same name and number get "… (2)", "… (3)": a folder is never shared.
-- NULL = nothing stored yet, or stored before this (the files keep their keys until npm run storage:organise moves them).
ALTER TABLE applications ADD COLUMN storage_folder varchar(160)
  CONSTRAINT ck_applications_storage_folder CHECK (
    storage_folder IS NULL OR (storage_folder ~ '^[^/\\]+$' AND storage_folder NOT IN ('.', '..') AND btrim(storage_folder) = storage_folder));
CREATE UNIQUE INDEX uq_applications_storage_folder ON applications (lower(storage_folder)) WHERE storage_folder IS NOT NULL;

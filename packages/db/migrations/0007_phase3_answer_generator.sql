DROP INDEX `answers_norm_idx`;--> statement-breakpoint
ALTER TABLE `answers` ADD `generator` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `answers` ADD `retired_at` integer;--> statement-breakpoint
CREATE INDEX `answers_norm_idx` ON `answers` (`scope_key`,`generator`,`question_norm`);--> statement-breakpoint
-- Backfill: label saved answers with what generated them (model + prompt version).
UPDATE `answers` SET `generator` = coalesce(`model`, '') || '|' || `prompt_version` WHERE `generator` = '';--> statement-breakpoint
-- Answers not written by the configured tutor model (eval runs with another model, fallbacks)
-- are kept as history but never served.
UPDATE `answers` SET `retired_at` = (unixepoch('subsec') * 1000)
WHERE `retired_at` IS NULL
  AND coalesce(`model`, '') <> coalesce((SELECT `primary_model` FROM `model_registry` WHERE `task` = 'tutor_chat'), 'google/gemini-2.5-flash');

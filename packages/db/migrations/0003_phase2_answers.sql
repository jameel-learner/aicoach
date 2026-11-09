CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`question` text NOT NULL,
	`question_norm` text NOT NULL,
	`embedding` text NOT NULL,
	`answer` text NOT NULL,
	`citations` text NOT NULL,
	`not_in_book` integer DEFAULT false NOT NULL,
	`variant_no` integer DEFAULT 1 NOT NULL,
	`model` text,
	`prompt_version` text NOT NULL,
	`created_by` text,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answers_scope_idx` ON `answers` (`scope_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `answers_norm_idx` ON `answers` (`scope_key`,`question_norm`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`questions` integer NOT NULL,
	`citation_accuracy` real NOT NULL,
	`correctness` real NOT NULL,
	`notes` text,
	`details` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `llm_usage` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `llm_usage` ADD `reconciled_usd_nano` integer;
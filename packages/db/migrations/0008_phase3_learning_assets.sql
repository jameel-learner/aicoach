CREATE TABLE `generation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`offering_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`kind` text NOT NULL,
	`chapters` text,
	`status` text DEFAULT 'running' NOT NULL,
	`status_message` text,
	`progress` text,
	`cost_usd_nano` integer DEFAULT 0 NOT NULL,
	`workflow_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_id`) REFERENCES `exam_strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `learning_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`offering_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`version` integer NOT NULL,
	`kind` text NOT NULL,
	`chapter` integer NOT NULL,
	`topic` text NOT NULL,
	`marks` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`content` text NOT NULL,
	`critique` text,
	`checks` text NOT NULL,
	`sources` text NOT NULL,
	`generator` text NOT NULL,
	`fixed` integer DEFAULT false NOT NULL,
	`strategy_id` text,
	`run_id` text,
	`cost_usd_nano` integer DEFAULT 0 NOT NULL,
	`review_score` integer,
	`review_note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_id`) REFERENCES `exam_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `generation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_assets_slot_version_uq` ON `learning_assets` (`slot_key`,`version`);--> statement-breakpoint
CREATE INDEX `learning_assets_offering_idx` ON `learning_assets` (`offering_id`,`kind`,`chapter`,`status`);
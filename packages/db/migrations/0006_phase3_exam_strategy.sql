CREATE TABLE `board_items` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`book_id` text NOT NULL,
	`page` integer,
	`source` text NOT NULL,
	`paper_label` text,
	`exam_year` integer,
	`qno` text NOT NULL,
	`part` text,
	`marks` integer,
	`chapter` integer,
	`topic` text NOT NULL,
	`topic_group` text,
	`typology` text NOT NULL,
	`cognitive` text,
	`difficulty` text,
	`text` text NOT NULL,
	`answer` text,
	`mark_split` text,
	`marking_points` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `exam_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `board_items_strategy_idx` ON `board_items` (`strategy_id`,`chapter`);--> statement-breakpoint
CREATE INDEX `board_items_book_idx` ON `board_items` (`strategy_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `exam_strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`offering_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'compiling' NOT NULL,
	`status_message` text,
	`progress` text,
	`strategy` text,
	`source_book_ids` text NOT NULL,
	`cost_usd_nano` integer DEFAULT 0 NOT NULL,
	`prompt_version` text NOT NULL,
	`workflow_id` text,
	`review_note` text,
	`created_by` text NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_strategies_version_uq` ON `exam_strategies` (`offering_id`,`version`);
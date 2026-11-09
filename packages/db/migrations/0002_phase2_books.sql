CREATE TABLE `book_pages` (
	`book_id` text NOT NULL,
	`page_no` integer NOT NULL,
	`markdown` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`flags` text,
	`error` text,
	`cost_usd_nano` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`book_id`, `page_no`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`offering_id` text NOT NULL,
	`edition` text,
	`language` text DEFAULT 'en' NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`status_message` text,
	`published_version` text,
	`next_version` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'ingested' NOT NULL,
	`workflow_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`version` text NOT NULL,
	`chunk_no` integer NOT NULL,
	`page_from` integer NOT NULL,
	`page_to` integer NOT NULL,
	`section` text,
	`text` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chunks_book_idx` ON `chunks` (`book_id`,`version`,`chunk_no`);--> statement-breakpoint
CREATE TABLE `institution_books` (
	`institution_id` text NOT NULL,
	`book_id` text NOT NULL,
	`mapped_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`institution_id`, `book_id`),
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Hand-written (Drizzle can't express FTS5): keyword search over chunk text, for terms, symbols
-- and exercise numbers that embeddings handle poorly (architecture §3.3). Kept in sync by code.
CREATE VIRTUAL TABLE `chunks_fts` USING fts5(`chunk_id` UNINDEXED, `book` UNINDEXED, `section`, `text`, tokenize = 'porter unicode61');

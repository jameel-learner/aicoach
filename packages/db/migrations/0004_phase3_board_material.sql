ALTER TABLE `books` ADD `kind` text DEFAULT 'textbook' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `category` text;--> statement-breakpoint
ALTER TABLE `books` ADD `academic_year` text;--> statement-breakpoint
ALTER TABLE `books` ADD `related_book_id` text;--> statement-breakpoint
ALTER TABLE `books` ADD `removed_pages` text;
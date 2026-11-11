CREATE TABLE `asset_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`role` text NOT NULL,
	`score` integer NOT NULL,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `learning_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_reviews_asset_reviewer_uq` ON `asset_reviews` (`asset_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `asset_reviews_asset_idx` ON `asset_reviews` (`asset_id`);
CREATE TABLE `card_reviews` (
	`user_id` text NOT NULL,
	`offering_id` text NOT NULL,
	`card_key` text NOT NULL,
	`chapter` integer NOT NULL,
	`box` integer NOT NULL,
	`due_at` integer NOT NULL,
	`reviews` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`last_rating` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `offering_id`, `card_key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `card_reviews_due_idx` ON `card_reviews` (`user_id`,`offering_id`,`chapter`,`due_at`);--> statement-breakpoint
CREATE TABLE `learner_artefacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`offering_id` text NOT NULL,
	`kind` text NOT NULL,
	`chapter` integer NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`card_key` text,
	`content` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `learner_artefacts_user_idx` ON `learner_artefacts` (`user_id`,`offering_id`,`kind`,`chapter`);--> statement-breakpoint
CREATE TABLE `learner_interests` (
	`user_id` text PRIMARY KEY NOT NULL,
	`interests` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mastery` (
	`user_id` text NOT NULL,
	`offering_id` text NOT NULL,
	`chapter` integer NOT NULL,
	`topic` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`best` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`last_session_id` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `offering_id`, `chapter`, `topic`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `safety_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`session_id` text,
	`detector` text NOT NULL,
	`rule` text NOT NULL,
	`notified` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `safety_events_user_idx` ON `safety_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`edge` text NOT NULL,
	`from_node` text NOT NULL,
	`to_node` text NOT NULL,
	`billed_micro` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_seq_uq` ON `session_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`offering_id` text NOT NULL,
	`enrolment_id` text,
	`journey` text NOT NULL,
	`graph_version` integer NOT NULL,
	`chapter` integer NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`node` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`billed_micro` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `subject_offerings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `study_sessions_user_idx` ON `study_sessions` (`user_id`,`offering_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `study_sessions_topic_idx` ON `study_sessions` (`user_id`,`offering_id`,`journey`,`chapter`,`topic`);
CREATE TABLE `allotment_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`allotment_id` text NOT NULL,
	`old_amount_micro` integer NOT NULL,
	`new_amount_micro` integer NOT NULL,
	`reason` text,
	`edited_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`allotment_id`) REFERENCES `allotments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `allotment_edits_allotment_idx` ON `allotment_edits` (`allotment_id`);--> statement-breakpoint
CREATE TABLE `allotments` (
	`id` text PRIMARY KEY NOT NULL,
	`from_wallet_id` text,
	`to_wallet_id` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`payment_id` text,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by` text,
	`locked_at` integer,
	`locked_by` text,
	FOREIGN KEY (`from_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `allotments_to_idx` ON `allotments` (`to_wallet_id`);--> statement-breakpoint
CREATE INDEX `allotments_from_idx` ON `allotments` (`from_wallet_id`);--> statement-breakpoint
CREATE TABLE `credit_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`request_id` text NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_holds_request_id_unique` ON `credit_holds` (`request_id`);--> statement-breakpoint
CREATE INDEX `holds_status_idx` ON `credit_holds` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `credit_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`parent_wallet_id` text NOT NULL,
	`to_admin` integer NOT NULL,
	`requested_by` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`message` text,
	`payment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`granted_micro` integer,
	`allotment_id` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`allotment_id`) REFERENCES `allotments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credit_requests_wallet_idx` ON `credit_requests` (`wallet_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credit_requests_parent_idx` ON `credit_requests` (`parent_wallet_id`,`status`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`allotment_id` text,
	`usage_id` text,
	`memo` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_wallet_idx` ON `ledger_entries` (`wallet_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `llm_models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`context_length` integer,
	`price_prompt_pico` integer DEFAULT 0 NOT NULL,
	`price_completion_pico` integer DEFAULT 0 NOT NULL,
	`input_modalities` text NOT NULL,
	`supports_json` integer DEFAULT false NOT NULL,
	`selectable` integer DEFAULT false NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`generation_id` text,
	`wallet_id` text NOT NULL,
	`user_id` text,
	`task` text NOT NULL,
	`model_requested` text NOT NULL,
	`model_used` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`raw_usd_nano` integer DEFAULT 0 NOT NULL,
	`fee_bps` integer NOT NULL,
	`usd_inr_paise` integer NOT NULL,
	`billed_micro` integer DEFAULT 0 NOT NULL,
	`cache_status` text DEFAULT 'miss' NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`latency_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_usage_request_id_unique` ON `llm_usage` (`request_id`);--> statement-breakpoint
CREATE INDEX `usage_wallet_idx` ON `llm_usage` (`wallet_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_generation_idx` ON `llm_usage` (`generation_id`);--> statement-breakpoint
CREATE TABLE `model_registry` (
	`task` text PRIMARY KEY NOT NULL,
	`primary_model` text NOT NULL,
	`fallback_models` text NOT NULL,
	`max_tokens` integer,
	`temperature` real,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payer_type` text NOT NULL,
	`institution_id` text,
	`user_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`method` text NOT NULL,
	`reference` text,
	`paid_on` text NOT NULL,
	`note` text,
	`recorded_by` text NOT NULL,
	`status` text DEFAULT 'verified' NOT NULL,
	`verified_by` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_inst_idx` ON `payments` (`institution_id`);--> statement-breakpoint
CREATE INDEX `payments_reference_idx` ON `payments` (`reference`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`);--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`institution_id` text,
	`class_group_id` text,
	`user_id` text,
	`parent_wallet_id` text,
	`path` text NOT NULL,
	`balance_micro` integer DEFAULT 0 NOT NULL,
	`held_micro` integer DEFAULT 0 NOT NULL,
	`daily_cap_micro` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`class_group_id`) REFERENCES `class_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wallet_funds_ok" CHECK("wallets"."held_micro" >= 0 AND "wallets"."balance_micro" >= "wallets"."held_micro")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_path_unique` ON `wallets` (`path`);--> statement-breakpoint
CREATE INDEX `wallets_parent_idx` ON `wallets` (`parent_wallet_id`);--> statement-breakpoint
CREATE INDEX `wallets_user_idx` ON `wallets` (`user_id`);
ALTER TABLE "attachments" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "text_note" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "text_extracted_at" timestamp with time zone;
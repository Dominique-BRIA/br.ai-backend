ALTER TABLE "orders" ADD COLUMN "handoff_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "relay_from_session_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_relay_from_session_id_sessions_id_fk" FOREIGN KEY ("relay_from_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
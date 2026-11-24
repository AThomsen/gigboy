ALTER TABLE "band_invites" ADD COLUMN "allow_signup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "band_members" ADD COLUMN "invited_by_id" text;--> statement-breakpoint
ALTER TABLE "bands" ADD COLUMN "member_signup" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by_id" text;--> statement-breakpoint
ALTER TABLE "band_members" ADD CONSTRAINT "band_members_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bands" ADD CONSTRAINT "bands_member_signup_check" CHECK ("bands"."member_signup" in ('none', 'owner', 'editors'));--> statement-breakpoint
-- Accounts created from a server invite before this column existed: credit that invite's admin.
UPDATE "users" SET "invited_by_id" = "user_invites"."inviter_id"
FROM "user_invites"
WHERE "user_invites"."accepted_user_id" = "users"."id"
  AND "user_invites"."inviter_id" <> "users"."id";

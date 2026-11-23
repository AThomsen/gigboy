CREATE TABLE "song_stems" (
	"id" text PRIMARY KEY NOT NULL,
	"song_id" text NOT NULL,
	"band_id" text NOT NULL,
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"waveform_bars" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"uploader_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "song_stems_song_name_unique" UNIQUE("song_id","name")
);
--> statement-breakpoint
ALTER TABLE "song_stems" ADD CONSTRAINT "song_stems_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_stems" ADD CONSTRAINT "song_stems_band_id_bands_id_fk" FOREIGN KEY ("band_id") REFERENCES "public"."bands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_stems" ADD CONSTRAINT "song_stems_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
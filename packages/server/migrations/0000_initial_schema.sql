CREATE TYPE "public"."invoice_type" AS ENUM('normal', 'storno');--> statement-breakpoint
CREATE TYPE "public"."nav_submission_status" AS ENUM('pending', 'sent', 'done', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'transfer', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient" text NOT NULL,
	"template" text NOT NULL,
	"invoice_id" uuid,
	"dedupe_key" text NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_log_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "invoice_sequence" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"type" "invoice_type" NOT NULL,
	"original_invoice_id" uuid,
	"reference" text,
	"request_hash" text,
	"issue_date" date NOT NULL,
	"fulfilment_date" date NOT NULL,
	"due_date" date NOT NULL,
	"seller_snapshot" jsonb NOT NULL,
	"buyer_snapshot" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"total_net" integer NOT NULL,
	"total_vat" integer NOT NULL,
	"total_gross" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"currency" text DEFAULT 'HUF' NOT NULL,
	"note" text,
	"email_to" text,
	"pdf_path" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_outcome" text
);
--> statement-breakpoint
CREATE TABLE "nav_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"transaction_id" text,
	"status" "nav_submission_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"request_xml" text,
	"response_xml" text,
	"error_code" text,
	"error_message" text,
	"last_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_submissions" ADD CONSTRAINT "nav_submissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_normal_per_reference" ON "invoices" USING btree ("reference") WHERE "invoices"."type" = 'normal' and "invoices"."reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_storno_per_original" ON "invoices" USING btree ("original_invoice_id") WHERE "invoices"."type" = 'storno';
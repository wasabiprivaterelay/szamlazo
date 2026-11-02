-- The single row the invoice numbering locks with SELECT ... FOR UPDATE.
INSERT INTO "invoice_sequence" ("id", "last_number") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "invoice_sequence" ADD CONSTRAINT "invoice_sequence_single_row" CHECK ("id" = 1);
--> statement-breakpoint
ALTER TABLE "invoice_sequence" ADD CONSTRAINT "invoice_sequence_not_negative" CHECK ("last_number" >= 0);
--> statement-breakpoint
-- A storno points at an invoice that exists, and never at another storno's row.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_id_fk"
  FOREIGN KEY ("original_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_storno_has_original"
  CHECK (("type" = 'storno') = ("original_invoice_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_totals_add_up"
  CHECK ("total_net" + "total_vat" = "total_gross");
--> statement-breakpoint
-- An issued invoice is a legal record: corrections are storno rows, never an
-- edit. The application already works that way; this makes the database
-- refuse anything else, including a mistake made by hand on the server.
CREATE FUNCTION "reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows are never changed or deleted', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "invoices_append_only"
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "reject_change"();
--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "reject_change"();

-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"opening_balance" numeric(15, 2) DEFAULT '0',
	"current_balance" numeric(15, 2) DEFAULT '0',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"synced_at" timestamp,
	"business_id" varchar(255),
	"company_guid" varchar(255),
	CONSTRAINT "vendors_guid_company_key" UNIQUE("guid","company_guid")
);
--> statement-breakpoint
CREATE TABLE "outstanding_aging" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer,
	"customer_id" integer,
	"entity_type" varchar(20),
	"current_0_30_days" numeric(15, 2) DEFAULT '0',
	"current_31_60_days" numeric(15, 2) DEFAULT '0',
	"current_61_90_days" numeric(15, 2) DEFAULT '0',
	"current_over_90_days" numeric(15, 2) DEFAULT '0',
	"total_outstanding" numeric(15, 2) DEFAULT '0',
	"calculated_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"company_guid" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "payment_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer,
	"customer_id" integer,
	"entity_type" varchar(20),
	"avg_settlement_days" numeric(10, 2),
	"min_settlement_days" integer,
	"max_settlement_days" integer,
	"payment_count" integer,
	"on_time_count" integer,
	"delayed_count" integer,
	"on_time_percentage" numeric(5, 2),
	"calculated_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"company_guid" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"opening_balance" numeric(15, 2) DEFAULT '0',
	"current_balance" numeric(15, 2) DEFAULT '0',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"synced_at" timestamp,
	"business_id" varchar(255),
	"company_guid" varchar(255),
	CONSTRAINT "customers_guid_company_key" UNIQUE("guid","company_guid")
);
--> statement-breakpoint
CREATE TABLE "payment_anomalies" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer,
	"vendor_id" integer,
	"customer_id" integer,
	"anomaly_type" varchar(50),
	"expected_value" numeric(15, 2),
	"actual_value" numeric(15, 2),
	"deviation_percentage" numeric(5, 2),
	"severity" varchar(20),
	"detected_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"insight_type" varchar(50),
	"title" varchar(255),
	"description" text,
	"severity" varchar(20),
	"confidence" numeric(5, 2),
	"data" jsonb,
	"valid_until" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cashflow_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"prediction_date" date,
	"expected_inflow" numeric(15, 2),
	"expected_outflow" numeric(15, 2),
	"net_cashflow" numeric(15, 2),
	"confidence" numeric(5, 2),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(255) NOT NULL,
	"voucher_number" varchar(100),
	"voucher_type" varchar(50) NOT NULL,
	"date" date NOT NULL,
	"party_name" varchar(255),
	"amount" numeric(15, 2) NOT NULL,
	"narration" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"synced_at" timestamp,
	"business_id" varchar(255),
	"item_name" varchar(255),
	"item_code" varchar(255),
	"company_guid" varchar(255),
	CONSTRAINT "transactions_guid_company_key" UNIQUE("guid","company_guid")
);
--> statement-breakpoint
CREATE TABLE "vendor_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer,
	"reliability_score" numeric(5, 2),
	"payment_history_score" numeric(5, 2),
	"volume_score" numeric(5, 2),
	"overall_score" numeric(5, 2),
	"risk_level" varchar(20),
	"notes" text,
	"calculated_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"company_guid" varchar(255),
	CONSTRAINT "vendor_scores_vendor_id_key" UNIQUE("vendor_id")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_guid" varchar(255) NOT NULL,
	"company_name" varchar(500) NOT NULL,
	"tally_company_name" varchar(500),
	"verified" boolean DEFAULT false,
	"registered_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"last_sync" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "companies_company_guid_key" UNIQUE("company_guid")
);
--> statement-breakpoint
ALTER TABLE "outstanding_aging" ADD CONSTRAINT "outstanding_aging_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outstanding_aging" ADD CONSTRAINT "outstanding_aging_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cycles" ADD CONSTRAINT "payment_cycles_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cycles" ADD CONSTRAINT "payment_cycles_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_anomalies" ADD CONSTRAINT "payment_anomalies_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_scores" ADD CONSTRAINT "vendor_scores_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vendor_business" ON "vendors" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_vendor_guid" ON "vendors" USING btree ("guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_vendor_name" ON "vendors" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_vendors_company" ON "vendors" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_outstanding_aging_company" ON "outstanding_aging" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_outstanding_customer" ON "outstanding_aging" USING btree ("customer_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_outstanding_vendor" ON "outstanding_aging" USING btree ("vendor_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_cycles_company" ON "payment_cycles" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_cycles_customer" ON "payment_cycles" USING btree ("customer_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_cycles_vendor" ON "payment_cycles" USING btree ("vendor_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_customer_business" ON "customers" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_customer_guid" ON "customers" USING btree ("guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_customer_name" ON "customers" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_customers_company" ON "customers" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_anomalies_transaction" ON "payment_anomalies" USING btree ("transaction_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_insights_type" ON "ai_insights" USING btree ("insight_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_predictions_date" ON "cashflow_predictions" USING btree ("prediction_date" date_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_business" ON "transactions" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_date" ON "transactions" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_guid" ON "transactions" USING btree ("guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_party" ON "transactions" USING btree ("party_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_type" ON "transactions" USING btree ("voucher_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_company" ON "transactions" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_vendor_scores_company" ON "vendor_scores" USING btree ("company_guid" text_ops);--> statement-breakpoint
CREATE INDEX "idx_vendor_scores_vendor" ON "vendor_scores" USING btree ("vendor_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_companies_guid" ON "companies" USING btree ("company_guid" text_ops);
*/
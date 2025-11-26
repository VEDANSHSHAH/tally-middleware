import { pgTable, index, unique, serial, varchar, numeric, timestamp, foreignKey, integer, text, jsonb, date, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const vendors = pgTable("vendors", {
	id: serial().primaryKey().notNull(),
	guid: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	openingBalance: numeric("opening_balance", { precision: 15, scale:  2 }).default('0'),
	currentBalance: numeric("current_balance", { precision: 15, scale:  2 }).default('0'),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	syncedAt: timestamp("synced_at", { mode: 'string' }),
	businessId: varchar("business_id", { length: 255 }),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_vendor_business").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
	index("idx_vendor_guid").using("btree", table.guid.asc().nullsLast().op("text_ops")),
	index("idx_vendor_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("idx_vendors_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	unique("vendors_guid_company_key").on(table.guid, table.companyGuid),
]);

export const outstandingAging = pgTable("outstanding_aging", {
	id: serial().primaryKey().notNull(),
	vendorId: integer("vendor_id"),
	customerId: integer("customer_id"),
	entityType: varchar("entity_type", { length: 20 }),
	current030Days: numeric("current_0_30_days", { precision: 15, scale:  2 }).default('0'),
	current3160Days: numeric("current_31_60_days", { precision: 15, scale:  2 }).default('0'),
	current6190Days: numeric("current_61_90_days", { precision: 15, scale:  2 }).default('0'),
	currentOver90Days: numeric("current_over_90_days", { precision: 15, scale:  2 }).default('0'),
	totalOutstanding: numeric("total_outstanding", { precision: 15, scale:  2 }).default('0'),
	calculatedAt: timestamp("calculated_at", { mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_outstanding_aging_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	index("idx_outstanding_customer").using("btree", table.customerId.asc().nullsLast().op("int4_ops")),
	index("idx_outstanding_vendor").using("btree", table.vendorId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.vendorId],
			foreignColumns: [vendors.id],
			name: "outstanding_aging_vendor_id_fkey"
		}),
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "outstanding_aging_customer_id_fkey"
		}),
]);

export const paymentCycles = pgTable("payment_cycles", {
	id: serial().primaryKey().notNull(),
	vendorId: integer("vendor_id"),
	customerId: integer("customer_id"),
	entityType: varchar("entity_type", { length: 20 }),
	avgSettlementDays: numeric("avg_settlement_days", { precision: 10, scale:  2 }),
	minSettlementDays: integer("min_settlement_days"),
	maxSettlementDays: integer("max_settlement_days"),
	paymentCount: integer("payment_count"),
	onTimeCount: integer("on_time_count"),
	delayedCount: integer("delayed_count"),
	onTimePercentage: numeric("on_time_percentage", { precision: 5, scale:  2 }),
	calculatedAt: timestamp("calculated_at", { mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_payment_cycles_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	index("idx_payment_cycles_customer").using("btree", table.customerId.asc().nullsLast().op("int4_ops")),
	index("idx_payment_cycles_vendor").using("btree", table.vendorId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.vendorId],
			foreignColumns: [vendors.id],
			name: "payment_cycles_vendor_id_fkey"
		}),
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "payment_cycles_customer_id_fkey"
		}),
]);

export const customers = pgTable("customers", {
	id: serial().primaryKey().notNull(),
	guid: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	openingBalance: numeric("opening_balance", { precision: 15, scale:  2 }).default('0'),
	currentBalance: numeric("current_balance", { precision: 15, scale:  2 }).default('0'),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	syncedAt: timestamp("synced_at", { mode: 'string' }),
	businessId: varchar("business_id", { length: 255 }),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_customer_business").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
	index("idx_customer_guid").using("btree", table.guid.asc().nullsLast().op("text_ops")),
	index("idx_customer_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("idx_customers_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	unique("customers_guid_company_key").on(table.guid, table.companyGuid),
]);

export const paymentAnomalies = pgTable("payment_anomalies", {
	id: serial().primaryKey().notNull(),
	transactionId: integer("transaction_id"),
	vendorId: integer("vendor_id"),
	customerId: integer("customer_id"),
	anomalyType: varchar("anomaly_type", { length: 50 }),
	expectedValue: numeric("expected_value", { precision: 15, scale:  2 }),
	actualValue: numeric("actual_value", { precision: 15, scale:  2 }),
	deviationPercentage: numeric("deviation_percentage", { precision: 5, scale:  2 }),
	severity: varchar({ length: 20 }),
	detectedAt: timestamp("detected_at", { mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_anomalies_transaction").using("btree", table.transactionId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.transactionId],
			foreignColumns: [transactions.id],
			name: "payment_anomalies_transaction_id_fkey"
		}),
]);

export const aiInsights = pgTable("ai_insights", {
	id: serial().primaryKey().notNull(),
	insightType: varchar("insight_type", { length: 50 }),
	title: varchar({ length: 255 }),
	description: text(),
	severity: varchar({ length: 20 }),
	confidence: numeric({ precision: 5, scale:  2 }),
	data: jsonb(),
	validUntil: timestamp("valid_until", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_insights_type").using("btree", table.insightType.asc().nullsLast().op("text_ops")),
]);

export const cashflowPredictions = pgTable("cashflow_predictions", {
	id: serial().primaryKey().notNull(),
	predictionDate: date("prediction_date"),
	expectedInflow: numeric("expected_inflow", { precision: 15, scale:  2 }),
	expectedOutflow: numeric("expected_outflow", { precision: 15, scale:  2 }),
	netCashflow: numeric("net_cashflow", { precision: 15, scale:  2 }),
	confidence: numeric({ precision: 5, scale:  2 }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_predictions_date").using("btree", table.predictionDate.asc().nullsLast().op("date_ops")),
]);

export const transactions = pgTable("transactions", {
	id: serial().primaryKey().notNull(),
	guid: varchar({ length: 255 }).notNull(),
	voucherNumber: varchar("voucher_number", { length: 100 }),
	voucherType: varchar("voucher_type", { length: 50 }).notNull(),
	date: date().notNull(),
	partyName: varchar("party_name", { length: 255 }),
	amount: numeric({ precision: 15, scale:  2 }).notNull(),
	narration: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	syncedAt: timestamp("synced_at", { mode: 'string' }),
	businessId: varchar("business_id", { length: 255 }),
	itemName: varchar("item_name", { length: 255 }),
	itemCode: varchar("item_code", { length: 255 }),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_transaction_business").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
	index("idx_transaction_date").using("btree", table.date.asc().nullsLast().op("date_ops")),
	index("idx_transaction_guid").using("btree", table.guid.asc().nullsLast().op("text_ops")),
	index("idx_transaction_party").using("btree", table.partyName.asc().nullsLast().op("text_ops")),
	index("idx_transaction_type").using("btree", table.voucherType.asc().nullsLast().op("text_ops")),
	index("idx_transactions_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	unique("transactions_guid_company_key").on(table.guid, table.companyGuid),
]);

export const vendorScores = pgTable("vendor_scores", {
	id: serial().primaryKey().notNull(),
	vendorId: integer("vendor_id"),
	reliabilityScore: numeric("reliability_score", { precision: 5, scale:  2 }),
	paymentHistoryScore: numeric("payment_history_score", { precision: 5, scale:  2 }),
	volumeScore: numeric("volume_score", { precision: 5, scale:  2 }),
	overallScore: numeric("overall_score", { precision: 5, scale:  2 }),
	riskLevel: varchar("risk_level", { length: 20 }),
	notes: text(),
	calculatedAt: timestamp("calculated_at", { mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	companyGuid: varchar("company_guid", { length: 255 }),
}, (table) => [
	index("idx_vendor_scores_company").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	index("idx_vendor_scores_vendor").using("btree", table.vendorId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.vendorId],
			foreignColumns: [vendors.id],
			name: "vendor_scores_vendor_id_fkey"
		}),
	unique("vendor_scores_vendor_id_key").on(table.vendorId),
]);

export const companies = pgTable("companies", {
	id: serial().primaryKey().notNull(),
	companyGuid: varchar("company_guid", { length: 255 }).notNull(),
	companyName: varchar("company_name", { length: 500 }).notNull(),
	tallyCompanyName: varchar("tally_company_name", { length: 500 }),
	verified: boolean().default(false),
	registeredAt: timestamp("registered_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	lastSync: timestamp("last_sync", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_companies_guid").using("btree", table.companyGuid.asc().nullsLast().op("text_ops")),
	unique("companies_company_guid_key").on(table.companyGuid),
]);

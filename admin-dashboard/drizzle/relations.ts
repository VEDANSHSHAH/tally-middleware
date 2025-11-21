import { relations } from "drizzle-orm/relations";
import { vendors, outstandingAging, customers, paymentCycles, transactions, paymentAnomalies, vendorScores } from "./schema";

export const outstandingAgingRelations = relations(outstandingAging, ({one}) => ({
	vendor: one(vendors, {
		fields: [outstandingAging.vendorId],
		references: [vendors.id]
	}),
	customer: one(customers, {
		fields: [outstandingAging.customerId],
		references: [customers.id]
	}),
}));

export const vendorsRelations = relations(vendors, ({many}) => ({
	outstandingAgings: many(outstandingAging),
	paymentCycles: many(paymentCycles),
	vendorScores: many(vendorScores),
}));

export const customersRelations = relations(customers, ({many}) => ({
	outstandingAgings: many(outstandingAging),
	paymentCycles: many(paymentCycles),
}));

export const paymentCyclesRelations = relations(paymentCycles, ({one}) => ({
	vendor: one(vendors, {
		fields: [paymentCycles.vendorId],
		references: [vendors.id]
	}),
	customer: one(customers, {
		fields: [paymentCycles.customerId],
		references: [customers.id]
	}),
}));

export const paymentAnomaliesRelations = relations(paymentAnomalies, ({one}) => ({
	transaction: one(transactions, {
		fields: [paymentAnomalies.transactionId],
		references: [transactions.id]
	}),
}));

export const transactionsRelations = relations(transactions, ({many}) => ({
	paymentAnomalies: many(paymentAnomalies),
}));

export const vendorScoresRelations = relations(vendorScores, ({one}) => ({
	vendor: one(vendors, {
		fields: [vendorScores.vendorId],
		references: [vendors.id]
	}),
}));
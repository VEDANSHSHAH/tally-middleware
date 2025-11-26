import { db } from "@/lib/db";
import { companies, transactions, vendors, customers } from "@/lib/schema";
import { DataTable } from "@/components/ui/data-table";
import { columns } from "./columns";
import { sql } from "drizzle-orm";

async function getData() {
    // Fetch companies with counts
    const data = await db
        .select({
            id: companies.id,
            companyGuid: companies.companyGuid,
            companyName: companies.companyName,
            tallyCompanyName: companies.tallyCompanyName,
            verified: companies.verified,
            registeredAt: companies.registeredAt,
            lastSync: companies.lastSync,
            transactionCount: sql<number>`(SELECT count(*) FROM ${transactions} WHERE ${transactions.companyGuid} = ${companies.companyGuid})`,
            vendorCount: sql<number>`(SELECT count(*) FROM ${vendors} WHERE ${vendors.companyGuid} = ${companies.companyGuid})`,
            customerCount: sql<number>`(SELECT count(*) FROM ${customers} WHERE ${customers.companyGuid} = ${companies.companyGuid})`,
        })
        .from(companies);

    return data;
}

export default async function CompaniesPage() {
    const data = await getData();

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-2xl font-bold mb-5">Companies & Data Usage</h1>
            <DataTable columns={columns} data={data} searchKey="companyName" />
        </div>
    );
}

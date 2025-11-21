import { db } from "@/lib/db";
import { transactions } from "@/lib/schema";
import { DataTable } from "@/components/ui/data-table";
import { columns } from "./columns";
import { desc } from "drizzle-orm";

async function getData() {
    const data = await db
        .select({
            id: transactions.id,
            guid: transactions.guid,
            companyGuid: transactions.companyGuid,
            voucherNumber: transactions.voucherNumber,
            voucherType: transactions.voucherType,
            date: transactions.date,
            partyName: transactions.partyName,
            amount: transactions.amount,
            narration: transactions.narration,
        })
        .from(transactions)
        .orderBy(desc(transactions.date))
        .limit(1000);
    return data;
}

export default async function TransactionsPage() {
    const data = await getData();

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-2xl font-bold mb-5">Transactions</h1>
            <DataTable columns={columns} data={data} searchKey="partyName" />
        </div>
    );
}

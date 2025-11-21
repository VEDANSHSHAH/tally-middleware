import { db } from "@/lib/db";
import { customers } from "@/lib/schema";
import { DataTable } from "@/components/ui/data-table";
import { columns } from "./columns";

async function getData() {
    const data = await db
        .select({
            id: customers.id,
            guid: customers.guid,
            companyGuid: customers.companyGuid,
            name: customers.name,
            currentBalance: customers.currentBalance,
            openingBalance: customers.openingBalance,
        })
        .from(customers);
    return data;
}

export default async function CustomersPage() {
    const data = await getData();

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-2xl font-bold mb-5">Customers</h1>
            <DataTable columns={columns} data={data} searchKey="name" />
        </div>
    );
}

import { pool } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ tableName: string }> | { tableName: string } }
) {
    try {
        // Handle both sync and async params (Next.js 15+ uses async params)
        const params = await (context.params instanceof Promise ? context.params : Promise.resolve(context.params));
        const tableName = params.tableName;
        
        console.log("Fetching data for table:", tableName);
        
        // Validate table name to prevent SQL injection
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
            return NextResponse.json(
                { error: "Invalid table name" },
                { status: 400 }
            );
        }

        // Get table data with pagination
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get("limit") || "50", 10);
        const offset = parseInt(searchParams.get("offset") || "0", 10);

        console.log("Executing query for table:", tableName);
        
        // Get table data - use a simpler query that works for all tables
        const result = await pool.query(`
            SELECT * FROM "${tableName}"
            LIMIT $1 OFFSET $2
        `, [limit, offset]);

        console.log("Query successful, rows:", result.rows.length);

        return NextResponse.json({
            data: result.rows,
            columns: result.fields.map(field => field.name),
        });
    } catch (error: any) {
        console.error("Error fetching table data:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch table data" },
            { status: 500 }
        );
    }
}


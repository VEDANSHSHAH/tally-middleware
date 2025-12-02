from fastapi import APIRouter, HTTPException
import asyncpg
import os
from datetime import datetime

router = APIRouter()


async def get_db_pool():
  return await asyncpg.create_pool(
    os.getenv('DATABASE_URL'),
    min_size=2,
    max_size=10
  )


@router.get("/api/company/{company_guid}/dashboard")
async def get_dashboard(company_guid: str):
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      row = await conn.fetchrow(
        """
        SELECT 
          total_receivable,
          receivable_0_30,
          receivable_31_60,
          receivable_61_90,
          receivable_90_plus,
          customer_count,
          overdue_customer_count,
          top_overdue_customers,
          calculated_at,
          data_as_of_date
        FROM dashboard_metrics
        WHERE company_guid = $1
          AND data_as_of_date = CURRENT_DATE
          AND is_valid = TRUE
        ORDER BY calculated_at DESC
        LIMIT 1
        """,
        company_guid
      )

      if not row:
        raise HTTPException(status_code=404, detail="Dashboard not found")

      return {
        "company_guid": company_guid,
        "total_receivable": float(row["total_receivable"] or 0),
        "aging": {
          "0_30": float(row["receivable_0_30"] or 0),
          "31_60": float(row["receivable_31_60"] or 0),
          "61_90": float(row["receivable_61_90"] or 0),
          "90_plus": float(row["receivable_90_plus"] or 0),
        },
        "customer_count": row["customer_count"],
        "overdue_customer_count": row["overdue_customer_count"],
        "top_overdue_customers": row["top_overdue_customers"] or [],
        "calculated_at": row["calculated_at"].isoformat(),
        "as_of_date": row["data_as_of_date"].isoformat(),
      }
  finally:
    await pool.close()


@router.get("/api/company/{company_guid}/customers/{ledger_id}/aging")
async def get_customer_aging(company_guid: str, ledger_id: int):
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      customer = await conn.fetchrow(
        """
        SELECT 
          name,
          current_balance,
          days_overdue,
          payment_behavior,
          avg_payment_days
        FROM ledgers
        WHERE id = $1 AND company_guid = $2
        """,
        ledger_id,
        company_guid,
      )

      if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

      invoices = await conn.fetch(
        """
        SELECT 
          voucher_number,
          date as invoice_date,
          total_amount,
          amount_paid,
          amount_outstanding,
          payment_status,
          aging_bucket,
          days_since_due
        FROM vouchers
        WHERE party_ledger_id = $1
          AND company_guid = $2
          AND voucher_type IN ('SALES', 'Invoice')
          AND payment_status IN ('UNPAID', 'PARTIAL')
          AND is_cancelled = FALSE
        ORDER BY date DESC
        """,
        ledger_id,
        company_guid,
      )

      return {
        "customer_name": customer["name"],
        "total_outstanding": float(customer["current_balance"] or 0),
        "days_overdue": customer["days_overdue"],
        "payment_behavior": customer["payment_behavior"],
        "avg_payment_days": customer["avg_payment_days"],
        "invoices": [
          {
            "voucher_number": inv["voucher_number"],
            "invoice_date": inv["invoice_date"].isoformat(),
            "total_amount": float(inv["total_amount"]),
            "amount_paid": float(inv["amount_paid"] or 0),
            "amount_outstanding": float(inv["amount_outstanding"] or 0),
            "payment_status": inv["payment_status"],
            "aging_bucket": inv["aging_bucket"],
            "days_overdue": inv["days_since_due"],
          }
          for inv in invoices
        ],
      }
  finally:
    await pool.close()


@router.get("/api/company/{company_guid}/customers/outstanding")
async def get_all_outstanding(company_guid: str):
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      customers = await conn.fetch(
        """
        SELECT 
          id,
          name,
          current_balance,
          days_overdue,
          payment_behavior,
          avg_payment_days,
          oldest_unpaid_date
        FROM ledgers
        WHERE company_guid = $1
          AND parent_group = 'Sundry Debtors'
          AND current_balance > 0
          AND active = TRUE
        ORDER BY current_balance DESC
        """,
        company_guid,
      )

      return {
        "company_guid": company_guid,
        "total_outstanding": sum(float(c["current_balance"]) for c in customers),
        "customer_count": len(customers),
        "customers": [
          {
            "id": c["id"],
            "name": c["name"],
            "outstanding": float(c["current_balance"]),
            "days_overdue": c["days_overdue"],
            "payment_behavior": c["payment_behavior"],
            "avg_payment_days": c["avg_payment_days"],
            "oldest_unpaid_date": c["oldest_unpaid_date"].isoformat()
            if c["oldest_unpaid_date"]
            else None,
          }
          for c in customers
        ],
      }
  finally:
    await pool.close()


@router.post("/api/admin/refresh-dashboard/{company_guid}")
async def refresh_dashboard(company_guid: str):
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      await conn.execute(
        """
        UPDATE vouchers v
        SET 
          amount_paid = COALESCE((
            SELECT SUM(pr.allocated_amount)
            FROM payment_references pr
            WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
          ), 0),
          amount_outstanding = v.total_amount - COALESCE((
            SELECT SUM(pr.allocated_amount)
            FROM payment_references pr
            WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
          ), 0),
          payment_status = CASE
            WHEN v.is_cancelled THEN 'CANCELLED'
            WHEN COALESCE((
              SELECT SUM(pr.allocated_amount)
              FROM payment_references pr
              WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
            ), 0) >= v.total_amount THEN 'PAID'
            WHEN COALESCE((
              SELECT SUM(pr.allocated_amount)
              FROM payment_references pr
              WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
            ), 0) > 0 THEN 'PARTIAL'
            ELSE 'UNPAID'
          END,
          payment_computed_at = NOW()
        WHERE v.company_guid = $1
          AND v.voucher_type IN ('SALES', 'Invoice')
        """,
        company_guid,
      )

      await conn.execute(
        """
        UPDATE ledgers l
        SET 
          days_overdue = COALESCE(
            CURRENT_DATE - (
              SELECT MIN(v.date)
              FROM vouchers v
              WHERE v.party_ledger_id = l.id
                AND v.payment_status IN ('UNPAID', 'PARTIAL')
            ), 
            0
          ),
          aging_computed_at = NOW()
        WHERE l.company_guid = $1
          AND l.parent_group = 'Sundry Debtors'
        """,
        company_guid,
      )

      await conn.execute(
        """
        INSERT INTO dashboard_metrics (
          company_guid, total_receivable, receivable_0_30,
          receivable_31_60, receivable_61_90, receivable_90_plus,
          customer_count, calculated_at, data_as_of_date
        )
        SELECT 
          $1,
          COALESCE((
            SELECT SUM(current_balance)
            FROM ledgers
            WHERE company_guid = $1
              AND parent_group = 'Sundry Debtors'
              AND current_balance > 0
          ), 0),
          COALESCE((
            SELECT SUM(amount_outstanding)
            FROM vouchers
            WHERE company_guid = $1
              AND aging_bucket = '0-30'
              AND payment_status IN ('UNPAID', 'PARTIAL')
          ), 0),
          COALESCE((
            SELECT SUM(amount_outstanding)
            FROM vouchers
            WHERE company_guid = $1
              AND aging_bucket = '31-60'
              AND payment_status IN ('UNPAID', 'PARTIAL')
          ), 0),
          COALESCE((
            SELECT SUM(amount_outstanding)
            FROM vouchers
            WHERE company_guid = $1
              AND aging_bucket = '61-90'
              AND payment_status IN ('UNPAID', 'PARTIAL')
          ), 0),
          COALESCE((
            SELECT SUM(amount_outstanding)
            FROM vouchers
            WHERE company_guid = $1
              AND aging_bucket = '90+'
              AND payment_status IN ('UNPAID', 'PARTIAL')
          ), 0),
          COALESCE((
            SELECT COUNT(*)
            FROM ledgers
            WHERE company_guid = $1
              AND parent_group = 'Sundry Debtors'
              AND current_balance > 0
          ), 0),
          NOW(),
          CURRENT_DATE
        ON CONFLICT (company_guid, data_as_of_date) DO UPDATE SET
          total_receivable = EXCLUDED.total_receivable,
          receivable_0_30 = EXCLUDED.receivable_0_30,
          receivable_31_60 = EXCLUDED.receivable_31_60,
          receivable_61_90 = EXCLUDED.receivable_61_90,
          receivable_90_plus = EXCLUDED.receivable_90_plus,
          customer_count = EXCLUDED.customer_count,
          calculated_at = EXCLUDED.calculated_at
        """,
        company_guid,
      )

      return {
        "success": True,
        "message": f"Dashboard refreshed for {company_guid}",
        "refreshed_at": datetime.now().isoformat(),
      }
  finally:
    await pool.close()

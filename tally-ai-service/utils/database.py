import psycopg2
from psycopg2.extras import RealDictCursor
import os
from pathlib import Path
from dotenv import load_dotenv

# Always read the repository-level .env so nested empty files don't interfere
ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=True)

DATABASE_URL = os.getenv('DATABASE_URL')

def get_db_connection():
    """Get PostgreSQL connection"""
    if not DATABASE_URL:
        raise Exception("DATABASE_URL not found in environment variables")
    
    try:
        # Pass DATABASE_URL directly - don't strip query params!
        conn = psycopg2.connect(
            DATABASE_URL,
            cursor_factory=RealDictCursor
        )
        return conn
    except Exception as e:
        print(f"Database connection error: {e}")
        raise

def get_vendors():
    """Get all vendors"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM vendors")
        vendors = cursor.fetchall()
        cursor.close()
        conn.close()
        return vendors
    except Exception as e:
        print(f"Error fetching vendors: {e}")
        return []

def get_vendor_scores():
    """Get vendor scores with vendor details"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                vs.*,
                v.name as vendor_name,
                v.current_balance
            FROM vendor_scores vs
            JOIN vendors v ON v.id = vs.vendor_id
            ORDER BY vs.overall_score DESC
        """)
        scores = cursor.fetchall()
        cursor.close()
        conn.close()
        return scores
    except Exception as e:
        print(f"Error fetching vendor scores: {e}")
        return []

def get_transactions():
    """Get all transactions"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM transactions ORDER BY date DESC LIMIT 100")
        transactions = cursor.fetchall()
        cursor.close()
        conn.close()
        return transactions
    except Exception as e:
        print(f"Error fetching transactions: {e}")
        return []

def get_outstanding_aging():
    """Get outstanding aging data"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                oa.*,
                COALESCE(v.name, c.name) as entity_name
            FROM outstanding_aging oa
            LEFT JOIN vendors v ON v.id = oa.vendor_id
            LEFT JOIN customers c ON c.id = oa.customer_id
            ORDER BY oa.total_outstanding DESC
        """)
        aging = cursor.fetchall()
        cursor.close()
        conn.close()
        return aging
    except Exception as e:
        print(f"Error fetching aging data: {e}")
        return []

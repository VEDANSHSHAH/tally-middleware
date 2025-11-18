import openai
import os
from dotenv import load_dotenv

load_dotenv()

# Set API key (v0.28.1 style)
openai.api_key = os.getenv('OPENAI_API_KEY')

async def generate_vendor_insight(vendor_data):
    """Generate AI insight about a vendor"""
    
    try:
        prompt = f"""
You are a financial analyst. Analyze this vendor and provide a brief insight (2-3 sentences):

Vendor: {vendor_data.get('vendor_name')}
Balance: ₹{vendor_data.get('current_balance', 0):,.0f}
Overall Score: {vendor_data.get('overall_score', 0)}/100
Risk Level: {vendor_data.get('risk_level', 'unknown')}
Reliability Score: {vendor_data.get('reliability_score', 0)}/100

Provide:
1. Performance summary
2. Risk assessment
3. Recommendation for business owner

Keep it concise and actionable.
"""

        # v0.28.1 API syntax
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a financial analyst providing insights to business owners."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=150,
            temperature=0.7
        )
        
        return response.choices[0].message.content.strip()
    
    except Exception as e:
        print(f"OpenAI API error: {e}")
        return f"Unable to generate insight: {str(e)}"

async def generate_cashflow_insight(aging_data, transactions_data):
    """Generate cash flow insight based on aging and transactions"""
    
    try:
        total_outstanding = sum([float(a.get('total_outstanding', 0)) for a in aging_data])
        overdue = sum([float(a.get('current_61_90_days', 0)) + float(a.get('current_over_90_days', 0)) for a in aging_data])
        
        prompt = f"""
You are a financial analyst. Analyze this cash flow situation:

Total Outstanding: ₹{total_outstanding:,.0f}
Overdue (60+ days): ₹{overdue:,.0f}
Recent Transactions: {len(transactions_data)}

Provide a brief cash flow insight (2-3 sentences):
1. Current cash flow health
2. Any concerns about overdue amounts
3. Recommendation

Keep it concise and actionable.
"""

        # v0.28.1 API syntax
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a financial analyst."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=150,
            temperature=0.7
        )
        
        return response.choices[0].message.content.strip()
    
    except Exception as e:
        print(f"OpenAI API error: {e}")
        return "Unable to generate cash flow insight"

async def answer_question(question, context_data):
    """Answer natural language questions about business data"""
    
    try:
        context = f"""
You have access to this business data:

Vendors: {len(context_data.get('vendors', []))}
Transactions: {len(context_data.get('transactions', []))}

Answer the user's question based on this data.
"""

        # v0.28.1 API syntax
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": context},
                {"role": "user", "content": question}
            ],
            max_tokens=200,
            temperature=0.7
        )
        
        return response.choices[0].message.content.strip()
    
    except Exception as e:
        print(f"OpenAI API error: {e}")
        return f"Unable to answer question: {str(e)}"
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def detect_anomalies(transactions):
    """Detect anomalies in transactions"""
    
    if not transactions or len(transactions) < 5:
        return []
    
    # Convert to DataFrame
    df = pd.DataFrame(transactions)
    
    if 'amount' not in df.columns or df.empty:
        return []
    
    # Calculate statistics
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
    mean_amount = df['amount'].mean()
    std_amount = df['amount'].std()
    
    anomalies = []
    
    # Find outliers (> 2 standard deviations)
    for idx, row in df.iterrows():
        amount = float(row['amount'])
        if abs(amount - mean_amount) > 2 * std_amount:
            deviation_pct = ((amount - mean_amount) / mean_amount) * 100
            
            anomalies.append({
                'type': 'unusual_amount',
                'transaction_id': row.get('id'),
                'voucher_number': row.get('voucher_number'),
                'amount': amount,
                'expected_amount': round(mean_amount, 2),
                'deviation_percentage': round(deviation_pct, 2),
                'severity': 'high' if abs(deviation_pct) > 300 else 'medium',
                'message': f"Amount ₹{amount:,.0f} is {abs(deviation_pct):.0f}% different from average"
            })
    
    return anomalies

def predict_cashflow(transactions, aging_data):
    """Predict next month's cash flow"""
    
    if not transactions or len(transactions) < 3:
        return {
            'prediction': 0,
            'confidence': 0,
            'message': 'Insufficient data for prediction'
        }
    
    # Convert to DataFrame
    df = pd.DataFrame(transactions)
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    
    # Calculate average daily transaction
    df_sorted = df.sort_values('date')
    recent_30_days = df_sorted.tail(30)
    
    if len(recent_30_days) > 0:
        avg_daily = recent_30_days['amount'].mean()
        predicted_monthly = avg_daily * 30
        
        # Confidence based on data availability
        confidence = min(len(recent_30_days) / 30, 1.0) * 100
        
        return {
            'predicted_amount': round(predicted_monthly, 2),
            'confidence': round(confidence, 2),
            'based_on_days': len(recent_30_days),
            'message': f'Predicted monthly cashflow: ₹{predicted_monthly:,.0f}'
        }
    
    return {
        'predicted_amount': 0,
        'confidence': 0,
        'message': 'Unable to predict cashflow'
    }

def analyze_payment_trends(transactions):
    """Analyze payment trends over time"""
    
    if not transactions:
        return {'trend': 'stable', 'message': 'No data available'}
    
    df = pd.DataFrame(transactions)
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    
    # Group by month
    df['month'] = df['date'].dt.to_period('M')
    monthly = df.groupby('month')['amount'].sum()
    
    if len(monthly) >= 2:
        recent = monthly.iloc[-1]
        previous = monthly.iloc[-2]
        
        change_pct = ((recent - previous) / previous) * 100 if previous != 0 else 0
        
        trend = 'increasing' if change_pct > 5 else ('decreasing' if change_pct < -5 else 'stable')
        
        return {
            'trend': trend,
            'change_percentage': round(change_pct, 2),
            'current_month': float(recent),
            'previous_month': float(previous),
            'message': f'Payments are {trend} by {abs(change_pct):.1f}%'
        }
    
    return {'trend': 'stable', 'message': 'Insufficient data for trend analysis'}
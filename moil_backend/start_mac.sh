#!/bin/bash
echo ""
echo " ================================================"
echo "  Moil Primary School - Attendance System"
echo "  Starting up..."
echo " ================================================"
echo ""

# Install dependencies
pip3 install -r requirements.txt --quiet

echo " Opening in your browser at http://localhost:5000"
echo " Press Ctrl+C to stop"
echo ""

# Open browser after 2 seconds (macOS)
sleep 2 && open http://localhost:5000 2>/dev/null &

# Start Flask
python3 app.py

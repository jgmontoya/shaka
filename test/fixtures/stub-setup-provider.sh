#!/bin/sh
# Simulates a provider TUI session: writes canned autoresearch.md and
# autoresearch.sh into cwd, then exits 0.
set -e
cat > autoresearch.md <<'EOF'
# Test objective

## Metric
- command: ./autoresearch.sh
- direction: minimize
- unit: s
EOF

cat > autoresearch.sh <<'EOF'
#!/bin/sh
echo "METRIC name=stub value=1.0 unit=s"
EOF
chmod +x autoresearch.sh

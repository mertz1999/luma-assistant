make deploy-start
make deploy-stop
sudo cp /Users/applestation/Project/archive/agentic-assistant/agentic-cli/scripts/nginx/agentic-cli.conf.example /etc/nginx/sites-available/agentic-cli.conf
sudo ln -sf /etc/nginx/sites-available/agentic-cli.conf /etc/nginx/sites-enabled/agentic-cli.conf
sudo nginx -t && sudo systemctl reload nginx

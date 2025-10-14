#!/bin/bash
# GitHub Account Switching Helper
# Usage: ./gh-switch.sh [nac|ajax|status]

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

show_status() {
    echo -e "${BLUE}=== GitHub Account Status ===${NC}\n"

    # Show gh CLI status
    echo -e "${YELLOW}gh CLI:${NC}"
    gh auth status 2>&1 | grep -E "(Logged in|Active account)" | sed 's/^/  /'

    echo ""

    # Show SSH keys in agent
    echo -e "${YELLOW}SSH Keys in Agent:${NC}"
    ssh-add -l 2>/dev/null | grep -E "(nac-codes|ajaxs-sheep)" | sed 's/^/  /'

    echo ""

    # Show current repo remote (if in a git repo)
    if git rev-parse --git-dir > /dev/null 2>&1; then
        echo -e "${YELLOW}Current Repo Remote:${NC}"
        git remote -v | grep origin | head -1 | sed 's/^/  /'
        echo ""
    fi
}

switch_to_nac() {
    echo -e "${GREEN}Switching to nac-codes...${NC}"
    gh auth switch -u nac-codes
    echo -e "${GREEN}✓ gh CLI switched to nac-codes${NC}"
    echo ""
    echo -e "${YELLOW}For git operations:${NC}"
    echo "  - Use SSH remotes with: git@github.com-nac:nac-codes/repo.git"
    echo "  - Or set remote: git remote set-url origin git@github.com-nac:nac-codes/REPO.git"
}

switch_to_ajax() {
    echo -e "${GREEN}Switching to ajaxs-sheep...${NC}"
    gh auth switch -u ajaxs-sheep
    echo -e "${GREEN}✓ gh CLI switched to ajaxs-sheep${NC}"
    echo ""
    echo -e "${YELLOW}For git operations:${NC}"
    echo "  - Use SSH remotes with: git@github.com-ajax:ajaxs-sheep/repo.git"
    echo "  - Or set remote: git remote set-url origin git@github.com-ajax:ajaxs-sheep/REPO.git"
}

show_help() {
    echo "GitHub Account Switching Helper"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  nac       Switch gh CLI to nac-codes"
    echo "  ajax      Switch gh CLI to ajaxs-sheep"
    echo "  status    Show current account status (default)"
    echo "  help      Show this help message"
    echo ""
    echo "Notes:"
    echo "  - Git push/pull will automatically use the correct account based on remote URL"
    echo "  - SSH remotes: git@github.com-nac for nac-codes, git@github.com-ajax for ajaxs-sheep"
    echo "  - gh CLI commands use the active account set via 'gh auth switch'"
}

case "${1:-status}" in
    nac)
        switch_to_nac
        ;;
    ajax)
        switch_to_ajax
        ;;
    status)
        show_status
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac

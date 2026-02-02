# How to Upload Your Ceramics Website to GitHub

Follow these steps to create a GitHub repository and upload your website files.

## Option 1: Using GitHub Website (Easiest)

### Step 1: Create a New Repository

1. Go to [github.com](https://github.com) and sign in (or create an account if you don't have one)
2. Click the "+" icon in the top right corner
3. Select "New repository"
4. Choose a repository name (e.g., "ceramics-website" or "my-ceramics")
5. Add a description (optional): "My ceramics portfolio website"
6. Choose "Public" (required for free GitHub Pages hosting)
7. **Do NOT** check "Add a README file" (we already have one)
8. Click "Create repository"

### Step 2: Upload Your Files

1. On your new repository page, click "uploading an existing file"
2. Drag and drop ALL the files from your ceramics-website folder:
   - index.html
   - README.md
   - .gitignore
   - images folder (with README.md inside)
3. Add a commit message: "Initial commit - ceramics website"
4. Click "Commit changes"

### Step 3: Enable GitHub Pages

1. In your repository, click "Settings"
2. Click "Pages" in the left sidebar
3. Under "Source", select "main" branch
4. Click "Save"
5. Wait a few minutes, then your site will be live at:
   `https://[your-username].github.io/[repository-name]`

## Option 2: Using Git Command Line

If you're comfortable with the command line:

```bash
# Navigate to your ceramics-website folder
cd path/to/ceramics-website

# Initialize git repository
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit - ceramics website"

# Add your GitHub repository as remote (replace with your repo URL)
git remote add origin https://github.com/your-username/your-repo-name.git

# Push to GitHub
git branch -M main
git push -u origin main
```

Then follow Step 3 above to enable GitHub Pages.

## Next Steps

### Adding Your Ceramic Images

1. In your repository, click on the "images" folder
2. Click "Add file" > "Upload files"
3. Upload your ceramic photos (JPG or PNG format recommended)
4. Commit the changes

### Editing Your Website

1. In your repository, click on "index.html"
2. Click the pencil icon (Edit this file)
3. Replace placeholder text with your actual content:
   - Update piece names
   - Add descriptions
   - Set prices
   - Link to your images (e.g., `images/vase-001.jpg`)
4. Commit your changes
5. Your live site will update automatically in a few minutes!

## Tips

- **Image sizes**: Keep images under 2MB for fast loading
- **Image names**: Use simple names without spaces (e.g., `bowl-blue.jpg`)
- **Testing locally**: Open index.html in your browser before pushing to test changes
- **Custom domain**: You can add a custom domain in GitHub Pages settings

## Need Help?

- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [Git Basics](https://git-scm.com/book/en/v2/Getting-Started-Git-Basics)

Enjoy your new ceramics website! 🏺

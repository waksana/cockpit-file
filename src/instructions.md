To give the user a file or image, write a standard Markdown link `[name](path)` or image `![alt](path)` in your reply text; the Files module then saves a copy the user can open or download, including from a remote browser.
Use an absolute path, a local `file:` URL or a path relative to the session cwd, pointing to a regular file within the module's size limit (100 MiB by default).
Paths that appear only in code spans or blocks, plain text or tool output are not captured, so always add the link. Each new reply captures the file's current bytes; link it again in a new reply after it changes.

//! The files in a flow's project folder (input, templates, config).

use super::*;

impl FlowService {
    /// The flow's folder, where relative paths in its steps point.
    pub fn project_dir(&self, id: &FlowId) -> CoreResult<PathBuf> {
        if !self.store.exists(id) {
            return Err(CoreError::FlowNotFound(id.clone()));
        }
        Ok(self.store.project_dir(id))
    }

    /// The folders and files of the flow's folder.
    pub fn project_files(&self, id: &FlowId) -> CoreResult<ProjectFiles> {
        project::list(id, &self.project_dir(id)?)
    }

    /// Absolute path of a file (or folder) in the flow's folder; it need
    /// not exist.
    pub fn project_path(&self, id: &FlowId, path: &str) -> CoreResult<PathBuf> {
        Ok(self.project_dir(id)?.join(project::relative_path(path)?))
    }

    /// Writes a file into the flow's folder (creating its folders).
    /// Refuses to replace an existing file unless `overwrite`.
    pub fn write_project_file(
        &self,
        id: &FlowId,
        path: &str,
        contents: &[u8],
        overwrite: bool,
    ) -> CoreResult<ProjectFile> {
        let target = self.project_path(id, path)?;
        if target.is_dir() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if !overwrite && target.exists() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::store::write_atomic(&target, contents)?;
        self.project_file_info(id, path)
    }

    /// Copies a file from anywhere on the PC into the flow's folder.
    pub fn copy_into_project(
        &self,
        id: &FlowId,
        from: &Path,
        path: &str,
        overwrite: bool,
    ) -> CoreResult<ProjectFile> {
        let target = self.project_path(id, path)?;
        if !from.is_file() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a file", from.display()),
            )));
        }
        if target.is_dir() || (!overwrite && target.exists()) {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Through a temporary file, so a reader never sees half a copy.
        let dir = target.parent().unwrap_or(&target);
        let tmp = tempfile::NamedTempFile::new_in(dir)?;
        std::fs::copy(from, tmp.path())?;
        tmp.persist(&target).map_err(|e| CoreError::Io(e.error))?;
        self.project_file_info(id, path)
    }

    /// Reads a file of the flow's folder.
    pub fn read_project_file(&self, id: &FlowId, path: &str) -> CoreResult<Vec<u8>> {
        let target = self.project_path(id, path)?;
        match std::fs::read(&target) {
            Ok(bytes) => Ok(bytes),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::IsADirectory
                ) || target.is_dir() =>
            {
                Err(CoreError::ProjectFileNotFound { path: path.into() })
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Creates a folder in the flow's folder (an existing one is fine).
    pub fn create_project_folder(&self, id: &FlowId, path: &str) -> CoreResult<()> {
        let target = self.project_path(id, path)?;
        if target.is_file() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        Ok(std::fs::create_dir_all(target)?)
    }

    /// Moves a file or folder of the flow's folder to the workspace
    /// trash (`trash/<id>.files.<unix-ts>/<path>`). A standard folder
    /// (`input/`, …) is emptied instead of removed.
    pub fn delete_project_file(&self, id: &FlowId, path: &str) -> CoreResult<()> {
        let rel = project::relative_path(path)?;
        let target = self.project_dir(id)?.join(&rel);
        if !target.exists() {
            return Err(CoreError::ProjectFileNotFound { path: path.into() });
        }
        let ts = now().unix_timestamp();
        let trash = self
            .store
            .root()
            .join("trash")
            .join(format!("{id}.files.{ts}"));
        let standard = project::FOLDERS.iter().any(|f| rel == Path::new(f.name));
        if standard {
            for entry in std::fs::read_dir(&target)? {
                let entry = entry?;
                let to = trash.join(&rel).join(entry.file_name());
                std::fs::create_dir_all(trash.join(&rel))?;
                std::fs::rename(entry.path(), to)?;
            }
            return Ok(());
        }
        let to = trash.join(&rel);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&target, &to)?;
        Ok(())
    }

    /// Renames (moves) a file or folder within the flow's folder.
    pub fn rename_project_file(
        &self,
        id: &FlowId,
        from: &str,
        to: &str,
    ) -> CoreResult<ProjectFile> {
        let source = self.project_path(id, from)?;
        let target = self.project_path(id, to)?;
        if !source.exists() {
            return Err(CoreError::ProjectFileNotFound { path: from.into() });
        }
        if target.exists() {
            return Err(CoreError::ProjectFileExists { path: to.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&source, &target)?;
        self.project_file_info(id, to)
    }

    pub(super) fn project_file_info(&self, id: &FlowId, path: &str) -> CoreResult<ProjectFile> {
        let rel = project::relative_path(path)?;
        let meta = std::fs::metadata(self.project_dir(id)?.join(&rel))?;
        Ok(ProjectFile {
            path: project::display_path(&rel),
            size: meta.len(),
            modified: meta.modified().ok().map(time::OffsetDateTime::from),
            in_use: false,
        })
    }

    /// The files of a flow's folder that travel in a bundle.
    pub(super) fn bundled_files(&self, id: &FlowId) -> CoreResult<Vec<BundledFile>> {
        use base64::Engine as _;
        let dir = self.store.project_dir(id);
        let mut out = Vec::new();
        for file in project::list(id, &dir)?.files {
            if !project::is_bundled(&file.path) {
                continue;
            }
            let bytes = std::fs::read(dir.join(project::relative_path(&file.path)?))?;
            out.push(BundledFile {
                flow_id: id.clone(),
                path: file.path,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
        Ok(out)
    }

    /// Writes the bundle's files of flow `from` into the folder of `to`
    /// (the same flow, or its copy), replacing files of the same name. On
    /// an update (`keep_input`) the files already under `input/` stay.
    pub(super) fn write_bundled_files(
        &self,
        from: &FlowId,
        to: &FlowId,
        files: &[BundledFile],
        keep_input: bool,
    ) -> CoreResult<()> {
        project::unpack(files, from, &self.project_dir(to)?, keep_input)
    }
}

Set WshShell = CreateObject("WScript.Shell")
Set FileSystem = CreateObject("Scripting.FileSystemObject")
ProjectRoot = FileSystem.GetParentFolderName(FileSystem.GetParentFolderName(WScript.ScriptFullName))
WshShell.CurrentDirectory = ProjectRoot
WshShell.Run "node.exe """ & ProjectRoot & "\bridge\server.mjs""", 0, False

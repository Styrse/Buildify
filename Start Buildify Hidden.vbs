Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c ""cd /d """ & appDir & """ && set BUILDIFY_START_MINIMIZED=1 && npm.cmd run dev"""

Set shell = CreateObject("WScript.Shell")
shell.Run command, 0, False

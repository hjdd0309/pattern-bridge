Option Explicit

Dim fso, oShell
Set fso    = CreateObject("Scripting.FileSystemObject")
Set oShell = CreateObject("WScript.Shell")

' scripts\ -> project root
Dim scriptDir, projectRoot
scriptDir   = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)

Dim electronExe, mainCjs
electronExe = projectRoot & "\node_modules\electron\dist\electron.exe"
mainCjs     = projectRoot & "\src\ui\main.cjs"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron not found." & vbCrLf & _
           "Run:  npm install" & vbCrLf & vbCrLf & _
           electronExe, vbCritical, "Pattern Bridge"
    WScript.Quit 1
End If

' windowStyle=1 (normal) so Electron's window appears normally.
' wscript.exe has no console window of its own, so no cmd flash.
oShell.Run """" & electronExe & """ """ & mainCjs & """", 1, False

Set oShell = Nothing
Set fso    = Nothing

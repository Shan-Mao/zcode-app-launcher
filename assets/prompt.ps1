Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "ZCode App Launcher"
$form.Size = New-Object System.Drawing.Size(470, 300)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)

$label = New-Object System.Windows.Forms.Label
$label.Text = "ZCode 正在运行，app.asar 被占用。`r`n请选择安装完成后是否重启客户端："
$label.SetBounds(20, 16, 420, 46)
$form.Controls.Add($label)

function New-Choice($text, $code, $top) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $text
  $btn.SetBounds(20, $top, 420, 38)
  $btn.Tag = $code
  $btn.Add_Click({ $form.Tag = $this.Tag; $form.Close() })
  $form.Controls.Add($btn)
}

New-Choice "是，立即重启并使用" "restart" 70
New-Choice "否，关闭后自动重启并使用" "restart-after-close" 114
New-Choice "否，关闭后自动使用，不重启" "after-close" 158

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "取消"
$cancel.SetBounds(20, 208, 420, 34)
$cancel.Add_Click({ $form.Tag = "cancel"; $form.Close() })
$form.Controls.Add($cancel)

$form.Add_Shown({ $form.Activate() })
$form.ShowDialog() | Out-Null
Write-Output $form.Tag

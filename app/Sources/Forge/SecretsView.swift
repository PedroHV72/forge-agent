// SecretsView — the vault, in the app.
//
// Adding a secret here is SAFER than the CLI: the app talks to the Keychain
// through the Security framework (SecItemAdd), so the value never appears in
// any process's argv. `security add-generic-password` has no such option —
// verified: passing the secret on stdin stores an empty string — so the CLI
// necessarily exposes it to `ps` for the duration of one exec.
//
// Everything else still goes through scripts/forge-secrets.js, so the registry
// format, the env-var table and the resolution rules have one implementation.

import SwiftUI
import Security
import ForgeKit

// MARK: - Model

struct StoredSecret: Codable, Identifiable, Hashable {
    let service: String
    let name: String
    let env_var: String
    let note: String?
    let store: String?
    let added_at: String?
    let has_secret: Bool?
    let is_default: Bool?

    var id: String { "\(service)/\(name)" }
    var isDefault: Bool { is_default ?? false }
    var hasSecret: Bool { has_secret ?? false }
}

// MARK: - Keychain (write path)

enum VaultKeychain {
    /// Same item shape scripts/forge-secrets.js uses, so a secret written here
    /// is readable by the CLI and vice versa: generic password, account = the
    /// OS user, service = forge-secret-<service>-<name>.
    static func serviceName(_ service: String, _ name: String) -> String {
        "forge-secret-\(service)-\(name)"
    }

    @discardableResult
    static func set(_ secret: String, service: String, name: String) -> OSStatus {
        let account = NSUserName()
        let svc = serviceName(service, name)
        let data = Data(secret.utf8)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrService as String: svc,
        ]
        // Update in place when it already exists, so re-adding replaces rather
        // than failing with duplicate-item.
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return status }

        var insert = query
        insert[kSecValueData as String] = data
        return SecItemAdd(insert as CFDictionary, nil)
    }
}

// MARK: - Store

@MainActor
final class SecretsStore: ObservableObject {
    @Published private(set) var secrets: [StoredSecret] = []
    @Published private(set) var services: [String] = []
    @Published var error: String?

    var byService: [String: [StoredSecret]] {
        Dictionary(grouping: secrets, by: \.service)
    }

    func load() {
        secrets = ForgeCore.runJSON([StoredSecret].self,
                                    "forge-secrets.js", ["--list", "--json"]) ?? []
        if let rows = ForgeCore.runJSON([ServiceRow].self,
                                        "forge-secrets.js", ["--services", "--json"]) {
            services = rows.map(\.service).sorted()
        }
    }

    struct ServiceRow: Codable { let service: String; let env: String }

    /// Write the secret via the Security framework, then register the metadata
    /// through the engine. Two steps because only the second one knows the
    /// registry format — and only the first can avoid argv.
    func add(service: String, name: String, secret: String, note: String) -> Bool {
        let svc = service.trimmingCharacters(in: .whitespaces).lowercased()
        let nm = name.trimmingCharacters(in: .whitespaces)
        guard !svc.isEmpty, !nm.isEmpty, !secret.isEmpty else {
            error = "serviço, nome e segredo são obrigatórios"
            return false
        }

        let status = VaultKeychain.set(secret, service: svc, name: nm)
        guard status == errSecSuccess else {
            error = "Keychain recusou (status \(status))"
            return false
        }

        // Register with a placeholder the engine will overwrite in the Keychain
        // with the same value — cheap, and it keeps the registry writer in one
        // place instead of duplicating its format here.
        var args = ["--add", svc, nm]
        if !note.trimmingCharacters(in: .whitespaces).isEmpty {
            args += ["--note", note]
        }
        let r = ForgeCore.runWithInput("forge-secrets.js", args, input: secret)
        guard r.ok else {
            error = r.stderr.isEmpty ? "falha ao registrar" : r.stderr
            return false
        }
        error = nil
        load()
        return true
    }

    func remove(_ s: StoredSecret) {
        let r = ForgeCore.run("forge-secrets.js", ["--remove", s.service, s.name])
        if !r.ok { error = r.stderr }
        load()
    }

    func setDefault(_ s: StoredSecret) {
        let r = ForgeCore.run("forge-secrets.js", ["--default", s.service, s.name])
        if !r.ok { error = r.stderr }
        load()
    }

    func copyExecCommand(_ s: StoredSecret, state: AppState) {
        state.copyToPasteboard(
            "forge-secrets exec \(s.service) \(s.name) -- <comando>", label: "Comando")
    }
}

// MARK: - View

struct SecretsView: View {
    @StateObject private var store = SecretsStore()
    @ObservedObject var state: AppState
    @State private var adding = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                intro
                if let e = store.error {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                if store.secrets.isEmpty {
                    empty
                } else {
                    ForEach(store.byService.keys.sorted(), id: \.self) { svc in
                        serviceSection(svc, store.byService[svc] ?? [])
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Segredos")
        .onAppear { store.load() }
        .sheet(isPresented: $adding) {
            AddSecretSheet(store: store, isPresented: $adding)
        }
        .toolbar {
            ToolbarItem {
                Button { adding = true } label: {
                    Label("Adicionar", systemImage: "plus")
                }
            }
        }
    }

    private var intro: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 16)).foregroundStyle(Color.accentOrange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Guardados no Keychain").font(.callout).bold()
                Text("O valor nunca é exibido nem copiável. Para usar, rode o comando com forge-secrets exec — o segredo entra só no processo que precisa dele.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
    }

    private func serviceSection(_ service: String, _ items: [StoredSecret]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(service).font(.callout).bold()
                if let v = items.first?.env_var {
                    Text(v).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text(items.count == 1 ? "1 segredo" : "\(items.count) segredos")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { idx, s in
                    if idx > 0 { Divider().opacity(0.4) }
                    SecretRow(secret: s, store: store, state: state,
                              siblings: items.count)
                }
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum segredo guardado", systemImage: "key")
                .font(.callout)
            Text("Guarde tokens de CLIs (railway, vercel, fly…) e chaves de MCPs. Vários do mesmo serviço convivem — o nome é seu.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar segredo…") { adding = true }.controlSize(.small)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct SecretRow: View {
    let secret: StoredSecret
    @ObservedObject var store: SecretsStore
    @ObservedObject var state: AppState
    let siblings: Int
    @State private var confirmingRemove = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: secret.hasSecret ? "key.fill" : "key.slash")
                .font(.caption)
                .foregroundStyle(secret.hasSecret ? AnyShapeStyle(Color.green)
                                                  : AnyShapeStyle(Color.orange))
                .frame(width: 16)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(secret.name).font(.system(size: 13))
                    if secret.isDefault {
                        Text("padrão").font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                            .help("Usado quando o comando não diz qual")
                    }
                }
                if let n = secret.note, !n.isEmpty {
                    Text(n).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                if !secret.hasSecret {
                    Text("registrado sem valor no cofre — readicione")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            Spacer()

            if let store = secret.store {
                Text(store).font(.caption2).foregroundStyle(.tertiary)
                    .help(store == "keychain" ? "Guardado no Keychain"
                                              : "Guardado em arquivo 0600 (Keychain indisponível)")
            }

            IconMenu(help: "Opções") {
                Button("Copiar comando de uso") { store.copyExecCommand(secret, state: state) }
                if siblings > 1 && !secret.isDefault {
                    Button("Tornar padrão de \(secret.service)") { store.setDefault(secret) }
                }
                Divider()
                Button("Remover…", role: .destructive) { confirmingRemove = true }
            }
        }
        .padding(.vertical, 9)
        .confirmationDialog("Remover \(secret.id)?",
                            isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remover", role: .destructive) { store.remove(secret) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Apaga o registro e o valor do Keychain. O que já usa este segredo passa a falhar.")
        }
    }
}

struct AddSecretSheet: View {
    @ObservedObject var store: SecretsStore
    @Binding var isPresented: Bool

    @State private var service = ""
    @State private var name = ""
    @State private var secret = ""
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Novo segredo").font(.headline)

            HStack(spacing: 8) {
                TextField("serviço", text: $service)
                    .textFieldStyle(.roundedBorder).frame(width: 150)
                Menu {
                    ForEach(store.services, id: \.self) { s in
                        Button(s) { service = s }
                    }
                } label: {
                    Image(systemName: "list.bullet")
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Serviços conhecidos")

                TextField("nome (ex: producao, cliente-x)", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            // SecureField: the value is never rendered, and the app writes it to
            // the Keychain directly rather than through a command line.
            SecureField("segredo", text: $secret)
                .textFieldStyle(.roundedBorder)

            TextField("nota (opcional)", text: $note)
                .textFieldStyle(.roundedBorder)

            Text("Vários nomes do mesmo serviço convivem. O valor vai direto para o Keychain — não passa por linha de comando.")
                .font(.caption2).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Guardar") {
                    if store.add(service: service, name: name, secret: secret, note: note) {
                        isPresented = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(service.isEmpty || name.isEmpty || secret.isEmpty)
            }
        }
        .padding(20).frame(width: 470)
        .onAppear { store.load() }
    }
}

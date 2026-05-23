// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title IdentityRegistry — ERC-8004 Agent Identity
/// @notice Реестр идентичности AI-агентов. Каждый NFT (tokenId) — удостоверение агента,
///         указывающее на AgentCard (JSON) в децентрализованном хранилище.
/// @dev Полная имплементация ERC-8004 Identity Registry:
///      - ERC-721 + ERC721URIStorage для on-chain привязки tokenURI → AgentCard
///      - agentCardURI ДОЛЖЕН быть decentralized URI (ipfs://, ar://, etc.)
///      - Один адрес → один агент (soulbound-подобная механика)
///      - Owner может обновлять AgentCard URI (ротация endpoints, capabilities)
///
/// ИНВАРИАНТ DATA AVAILABILITY:
///   tokenURI хранится on-chain (ERC721URIStorage._tokenURIs mapping).
///   Содержимое по URI доступно через IPFS/Arweave — proof of data possession
///   гарантируется Filecoin Pin или Arweave permanent storage.
///
/// ИНВАРИАНТ СОВМЕСТИМОСТИ:
///   AgentCard JSON обязан содержать: name, description, capabilities[], endpoints{}, paymentAddresses{}
///   Отсутствие этих ключей делает агента невидимым для Agent-to-Agent discovery.
contract IdentityRegistry is ERC721URIStorage {
    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Адрес уже зарегистрировал агента
    error AgentAlreadyRegistered();

    /// @notice Вызывающий не является владельцем tokenId
    error NotTokenOwner();

    /// @notice Пустой URI недопустим
    error EmptyURI();

    /// @notice Нулевой адрес недопустим
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Новый агент зарегистрирован
    /// @param tokenId Уникальный идентификатор агента
    /// @param owner Адрес владельца
    /// @param agentCardURI URI метаданных (ipfs://... или ar://...)
    event AgentRegistered(
        uint256 indexed tokenId,
        address indexed owner,
        string agentCardURI
    );

    /// @notice AgentCard URI обновлён
    /// @param tokenId Идентификатор агента
    /// @param newURI Новый URI метаданных
    event AgentCardUpdated(uint256 indexed tokenId, string newURI);

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Монотонный счётчик tokenId (начинается с 1)
    uint256 private _nextTokenId;

    /// @notice Маппинг: адрес владельца → tokenId (0 = не зарегистрирован)
    mapping(address => uint256) public agentOf;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor() ERC721("AlphaFlow Identity Registry", "AFID") {}

    // ═══════════════════════════════════════════════════════════════════
    //                      EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Регистрация нового AI-агента. Один адрес = один агент.
    /// @param owner Адрес владельца агента (может быть EOA или smart account)
    /// @param agentCardURI URI метаданных AgentCard (формат: ipfs://CID или ar://TX_ID)
    /// @return tokenId Уникальный идентификатор зарегистрированного агента
    /// @dev agentCardURI инвариант: ДОЛЖЕН быть decentralized URI.
    ///      Централизованные URL (https://...) не гарантируют DA и нарушают стандарт.
    function registerAgent(
        address owner,
        string calldata agentCardURI
    ) external returns (uint256 tokenId) {
        // CHECKS
        if (owner == address(0)) revert ZeroAddress();
        if (bytes(agentCardURI).length == 0) revert EmptyURI();
        if (agentOf[owner] != 0) revert AgentAlreadyRegistered();

        // EFFECTS
        unchecked {
            tokenId = ++_nextTokenId;
        }
        agentOf[owner] = tokenId;

        // INTERACTIONS
        _safeMint(owner, tokenId);
        _setTokenURI(tokenId, agentCardURI);

        emit AgentRegistered(tokenId, owner, agentCardURI);
    }

    /// @notice Обновление AgentCard URI. Только владелец токена.
    /// @param tokenId ID агента
    /// @param newURI Новый URI метаданных
    /// @dev Используется при ротации endpoints, обновлении capabilities,
    ///      или миграции с IPFS на Arweave.
    function updateAgentCard(uint256 tokenId, string calldata newURI) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (bytes(newURI).length == 0) revert EmptyURI();

        _setTokenURI(tokenId, newURI);
        emit AgentCardUpdated(tokenId, newURI);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Общее количество зарегистрированных агентов
    function totalAgents() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Проверка: зарегистрирован ли агент для адреса
    /// @param account Проверяемый адрес
    /// @return true если агент существует
    function isRegistered(address account) external view returns (bool) {
        return agentOf[account] != 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      OVERRIDES
    // ═══════════════════════════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    /// @dev Soulbound Token: запрет на передачу (только mint и burn)
    /// AI-агент навсегда привязан к адресу создателя/smart account.
    /// Это также гарантирует синхронизацию маппинга agentOf.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        // Разрешаем только mint (from == 0) и burn (to == 0)
        require(
            from == address(0) || to == address(0),
            "IdentityRegistry: Agents are Soulbound and cannot be transferred"
        );
        return super._update(to, tokenId, auth);
    }
}
